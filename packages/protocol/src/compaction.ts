/**
 * Compaction contracts shared by agent hosts.
 *
 * Compaction replaces older model context with a summary while the Pi JSONL
 * history stays authoritative. These types describe the lifecycle state, the
 * display boundary rendered between summarized and kept history on the active
 * branch, and the bounded detail a host may fetch for one boundary.
 */

export const AGENT_COMPACTION_REASONS = ["manual", "threshold", "overflow"] as const;
export type AgentCompactionReason = (typeof AGENT_COMPACTION_REASONS)[number];

export const AGENT_COMPACTION_STATUSES = ["idle", "compacting"] as const;
export type AgentCompactionStatus = (typeof AGENT_COMPACTION_STATUSES)[number];

export const AGENT_COMPACTION_OUTCOMES = ["completed", "cancelled", "failed"] as const;
export type AgentCompactionOutcome = (typeof AGENT_COMPACTION_OUTCOMES)[number];

/** Bound on the summary text a host will read back across the bridge. */
export const MAX_COMPACTION_SUMMARY_CHARS = 64 * 1024;
/** Bound on sanitized compaction error text surfaced to the owner. */
export const MAX_COMPACTION_ERROR_CHARS = 300;

export interface AgentCompactionState {
  status: AgentCompactionStatus;
  /** Present while status is "compacting". */
  reason?: AgentCompactionReason;
  /** ISO start time of the in-flight operation, while compacting. */
  startedAt?: string;
  /**
   * True only for host-initiated manual operations. Automatic compaction
   * (threshold/overflow) belongs to the active run and is cancelled through
   * the run's Stop path, never through a dedicated cancel control.
   */
  cancelable: boolean;
}

export function idleAgentCompactionState(): AgentCompactionState {
  return { status: "idle", cancelable: false };
}

/**
 * Display boundary between summarized and kept history on the active branch.
 * Rendered inline in the transcript; the summarized messages stay visible
 * above it because the branch projection shows the full active branch.
 */
export interface AgentCompactionBoundary {
  kind: "compaction";
  /** Stable Pi entry id of the compaction record. */
  id: string;
  createdAt: string;
  reason?: AgentCompactionReason;
  tokensBefore: number;
  estimatedTokensAfter?: number;
  hasSummary: boolean;
  /** True when a session_before_compact hook supplied the summary content. */
  fromHook: boolean;
}

/** Bounded detail for one compaction boundary, fetched on demand. */
export interface AgentCompactionDetail {
  summary: string;
  truncated: boolean;
  tokensBefore: number;
  estimatedTokensAfter?: number;
}

export function isAgentCompactionReason(value: unknown): value is AgentCompactionReason {
  return value === "manual" || value === "threshold" || value === "overflow";
}

export function isAgentCompactionOutcome(value: unknown): value is AgentCompactionOutcome {
  return value === "completed" || value === "cancelled" || value === "failed";
}

export function isAgentCompactionState(value: unknown): value is AgentCompactionState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.status !== "idle" && record.status !== "compacting") {
    return false;
  }
  if (typeof record.cancelable !== "boolean") {
    return false;
  }
  if (record.reason !== undefined && !isAgentCompactionReason(record.reason)) {
    return false;
  }
  if (record.startedAt !== undefined && typeof record.startedAt !== "string") {
    return false;
  }
  if (record.status === "compacting") {
    return isAgentCompactionReason(record.reason) && typeof record.startedAt === "string";
  }
  return true;
}

export function isAgentCompactionBoundary(value: unknown): value is AgentCompactionBoundary {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.kind === "compaction" &&
    typeof record.id === "string" &&
    record.id.trim() !== "" &&
    typeof record.createdAt === "string" &&
    typeof record.tokensBefore === "number" &&
    Number.isFinite(record.tokensBefore) &&
    typeof record.hasSummary === "boolean" &&
    typeof record.fromHook === "boolean" &&
    (record.reason === undefined || isAgentCompactionReason(record.reason)) &&
    (record.estimatedTokensAfter === undefined ||
      (typeof record.estimatedTokensAfter === "number" && Number.isFinite(record.estimatedTokensAfter)))
  );
}

export function isAgentCompactionDetail(value: unknown): value is AgentCompactionDetail {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.summary === "string" &&
    typeof record.truncated === "boolean" &&
    typeof record.tokensBefore === "number" &&
    Number.isFinite(record.tokensBefore) &&
    (record.estimatedTokensAfter === undefined ||
      (typeof record.estimatedTokensAfter === "number" && Number.isFinite(record.estimatedTokensAfter)))
  );
}

/** Bound and flatten an arbitrary compaction failure for owner-facing display. */
export function sanitizeCompactionError(message: string): string {
  const flattened = message.replace(/\s+/gu, " ").trim();
  if (flattened.length <= MAX_COMPACTION_ERROR_CHARS) {
    return flattened;
  }
  return `${flattened.slice(0, MAX_COMPACTION_ERROR_CHARS - 1)}…`;
}
