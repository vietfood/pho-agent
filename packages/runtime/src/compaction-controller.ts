import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  createHarnessError,
  HARNESS_ERROR_CODES,
  idleAgentCompactionState,
  sanitizeCompactionError,
  type AgentCompactionOutcome,
  type AgentCompactionReason,
  type AgentCompactionState,
} from "@pho-agent/protocol";
import type { CompactionEnrichment } from "./display-transcript";

/**
 * Per-session compaction controller.
 *
 * Owns the manual-operation guard (one operation, only while idle, only with
 * a model), projects Pi's `compaction_start`/`compaction_end` events into
 * host-agnostic state, and retains live completion metadata so the newest
 * transcript boundary can show reason and estimated size until restart.
 *
 * The controller never calls Pi's automatic compaction paths; threshold and
 * overflow compaction stay Pi-owned and surface here only through events.
 */

export interface CompactionOutcomeNotice {
  outcome: AgentCompactionOutcome;
  reason: AgentCompactionReason;
  willRetry: boolean;
  tokensBefore?: number;
  estimatedTokensAfter?: number;
  errorMessage?: string;
}

export interface CompactionStateChange {
  state: AgentCompactionState;
  /** Present on compaction_end (including unpaired ends after a restart). */
  notice?: CompactionOutcomeNotice;
}

export type ManualCompactionResult =
  | { status: "completed"; tokensBefore: number; estimatedTokensAfter?: number }
  | { status: "cancelled" }
  | { status: "failed"; message: string };

export interface CompactionController {
  state(): AgentCompactionState;
  /** True while a manual operation is registered or any compaction is running. */
  busy(): boolean;
  /** True while a host-initiated manual operation is in flight (cancelable). */
  manualInFlight(): boolean;
  handleSessionEvent(event: AgentSessionEvent): CompactionStateChange | undefined;
  startManual(session: AgentSession, operation: string): Promise<ManualCompactionResult>;
  cancel(session: AgentSession): void;
  /**
   * Attach the latest live completion to a boundary entry when its timestamp
   * postdates the operation start. Returns the enrichment for that entry.
   */
  enrichBoundary(entryId: string, entryTimestamp: string): CompactionEnrichment | undefined;
  /** Clear transient operation state after session replacement. Enrichments survive. */
  reset(): void;
}

interface ManualOperation {
  startedAt: string;
  startedAtMs: number;
  cancelRequested: boolean;
}

interface PendingCompletion extends CompactionEnrichment {
  tokensBefore: number;
  startedAtMs: number;
}

export function createCompactionController(options?: { now?: () => number }): CompactionController {
  const now = options?.now ?? (() => Date.now());
  let state: AgentCompactionState = idleAgentCompactionState();
  let manual: ManualOperation | undefined;
  let pending: PendingCompletion | undefined;
  const enrichments = new Map<string, PendingCompletion>();

  function isAbort(error: unknown): boolean {
    return (
      (error instanceof Error && error.name === "AbortError") ||
      (error instanceof Error && error.message === "Compaction cancelled")
    );
  }

  return {
    state() {
      return state;
    },
    busy() {
      return manual !== undefined || state.status === "compacting";
    },
    manualInFlight() {
      return manual !== undefined;
    },
    handleSessionEvent(event) {
      if (event.type === "compaction_start") {
        state = {
          status: "compacting",
          reason: event.reason,
          startedAt: new Date(now()).toISOString(),
          cancelable: manual !== undefined,
        };
        return { state };
      }
      if (event.type === "compaction_end") {
        const startedAtMs = state.status === "compacting" && state.startedAt
          ? Date.parse(state.startedAt)
          : now();
        state = idleAgentCompactionState();
        // Pi 0.84.4 reports an abort that lands while the summarization
        // request is in flight as a failure ("The operation was aborted.")
        // rather than aborted. When the host requested the cancel, align the
        // projected outcome with the owner's action instead of showing a
        // misleading failure.
        const cancelledByHost = manual?.cancelRequested === true && !event.result;
        const notice: CompactionOutcomeNotice = {
          outcome: event.result ? "completed" : event.aborted || cancelledByHost ? "cancelled" : "failed",
          reason: event.reason,
          willRetry: event.willRetry,
          ...(event.result ? { tokensBefore: event.result.tokensBefore } : {}),
          ...(event.result?.estimatedTokensAfter !== undefined
            ? { estimatedTokensAfter: event.result.estimatedTokensAfter }
            : {}),
          ...(event.errorMessage && !cancelledByHost
            ? { errorMessage: sanitizeCompactionError(event.errorMessage) }
            : {}),
        };
        if (event.result) {
          pending = {
            reason: event.reason,
            estimatedTokensAfter: event.result.estimatedTokensAfter,
            willRetry: event.willRetry,
            tokensBefore: event.result.tokensBefore,
            startedAtMs: Number.isNaN(startedAtMs) ? now() : startedAtMs,
          };
        }
        return { state, notice };
      }
      return undefined;
    },
    async startManual(session, operation) {
      if (manual !== undefined || state.status === "compacting") {
        throw createHarnessError({
          code: HARNESS_ERROR_CODES.sessionBusy,
          message: "A compaction is already in progress for this chat.",
          operation,
          recoverable: true,
        });
      }
      if (!session.isIdle) {
        throw createHarnessError({
          code: HARNESS_ERROR_CODES.sessionBusy,
          message: "Wait for the current run to finish before compacting.",
          operation,
          recoverable: true,
        });
      }
      if (!session.model) {
        throw createHarnessError({
          code: HARNESS_ERROR_CODES.noAuthenticatedModel,
          message: "Select a model before compacting.",
          operation,
          recoverable: true,
        });
      }
      const startedAtMs = now();
      manual = { startedAt: new Date(startedAtMs).toISOString(), startedAtMs, cancelRequested: false };
      try {
        const result = await session.compact();
        return {
          status: "completed",
          tokensBefore: result.tokensBefore,
          ...(result.estimatedTokensAfter !== undefined
            ? { estimatedTokensAfter: result.estimatedTokensAfter }
            : {}),
        };
      } catch (error) {
        if (manual.cancelRequested || isAbort(error)) {
          return { status: "cancelled" };
        }
        const message = error instanceof Error ? error.message : String(error);
        return { status: "failed", message: sanitizeCompactionError(message) };
      } finally {
        manual = undefined;
      }
    },
    cancel(session) {
      if (!manual) {
        return;
      }
      manual.cancelRequested = true;
      session.abortCompaction();
    },
    enrichBoundary(entryId, entryTimestamp) {
      const existing = enrichments.get(entryId);
      if (existing) {
        return existing;
      }
      if (pending) {
        const entryMs = Date.parse(entryTimestamp);
        if (!Number.isNaN(entryMs) && entryMs >= pending.startedAtMs - 1_000) {
          enrichments.set(entryId, pending);
          pending = undefined;
          return enrichments.get(entryId);
        }
      }
      return undefined;
    },
    reset() {
      state = idleAgentCompactionState();
      manual = undefined;
      pending = undefined;
    },
  };
}
