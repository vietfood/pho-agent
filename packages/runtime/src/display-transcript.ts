import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  sessionEntryToContextMessages,
  type CompactionEntry,
  type SessionEntry,
  type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import {
  MAX_COMPACTION_SUMMARY_CHARS,
  type AgentCompactionBoundary,
  type AgentCompactionDetail,
  type AgentCompactionReason,
} from "@pho-agent/protocol";

/**
 * Active-branch display projection.
 *
 * The model context (`session.messages`) collapses after compaction; the
 * display transcript instead walks the full active branch so summarized
 * history stays visible behind a compaction boundary. This module owns the
 * branch classification and the id bookkeeping; hosts own message-content
 * rendering.
 */

export interface DisplayMessageItem {
  kind: "message";
  entry: SessionMessageEntry;
  /**
   * Index in the no-compaction context message sequence. Equals the index the
   * message had in `session.messages` before any compaction existed, which is
   * the legacy display-id scheme (`role:timestamp:index`).
   */
  branchContextIndex: number;
  /** Index in the current model context, when the message is still in it. */
  contextMessageIndex?: number;
}

export interface DisplayCompactionItem {
  kind: "compaction";
  entry: CompactionEntry;
}

export type DisplayTranscriptItem = DisplayMessageItem | DisplayCompactionItem;

/**
 * Classify active-branch entries into display items. `custom_message`,
 * `branch_summary`, and metadata entries contribute to context indexing (the
 * legacy id scheme counted them) but are not display items; hosts that render
 * custom messages can read the branch directly.
 */
export function collectDisplayTranscriptItems(
  branch: readonly SessionEntry[],
  contextMessages: readonly AgentMessage[],
): DisplayTranscriptItem[] {
  const contextIndex = buildContextIndex(contextMessages);
  const items: DisplayTranscriptItem[] = [];
  let branchContextIndex = 0;
  for (const entry of branch) {
    if (entry.type === "compaction") {
      // Compaction entries produce a summary message in the live context, but
      // the no-compaction sequence this index simulates never had one.
      items.push({ kind: "compaction", entry });
      continue;
    }
    const contextCount = sessionEntryToContextMessages(entry).length;
    if (entry.type === "message") {
      const item: DisplayMessageItem = { kind: "message", entry, branchContextIndex };
      const current = contextIndex(entry.message);
      if (current !== undefined) {
        item.contextMessageIndex = current;
      }
      items.push(item);
    }
    branchContextIndex += contextCount;
  }
  return items;
}

/**
 * Legacy display-id candidates for a message, oldest scheme first:
 * `role:timestamp:index` over the no-compaction sequence, then over the
 * current model context. Hosts use these to keep pre-migration overlay keys
 * (assistant-output rewrites) resolving after the stable-id cutover.
 */
export function legacyDisplayIdCandidates(item: DisplayMessageItem): string[] {
  const message = item.entry.message as { role?: unknown; timestamp?: unknown };
  if (typeof message.role !== "string" || typeof message.timestamp !== "number") {
    return [];
  }
  const ids = [`${message.role}:${message.timestamp}:${item.branchContextIndex}`];
  if (item.contextMessageIndex !== undefined && item.contextMessageIndex !== item.branchContextIndex) {
    ids.push(`${message.role}:${message.timestamp}:${item.contextMessageIndex}`);
  }
  return ids;
}

/** Live-event metadata that enriches the newest boundary until restart. */
export interface CompactionEnrichment {
  reason?: AgentCompactionReason;
  estimatedTokensAfter?: number;
  willRetry?: boolean;
}

export function projectCompactionBoundary(
  entry: CompactionEntry,
  enrichment?: CompactionEnrichment,
): AgentCompactionBoundary {
  return {
    kind: "compaction",
    id: entry.id,
    createdAt: entry.timestamp,
    tokensBefore: entry.tokensBefore,
    hasSummary: entry.summary.trim().length > 0,
    fromHook: entry.fromHook === true,
    ...(enrichment?.reason ? { reason: enrichment.reason } : {}),
    ...(enrichment?.estimatedTokensAfter !== undefined
      ? { estimatedTokensAfter: enrichment.estimatedTokensAfter }
      : {}),
  };
}

/** Bounded, JSON-safe detail for one compaction entry. */
export function compactionDetailFromEntry(
  entry: CompactionEntry,
  enrichment?: CompactionEnrichment,
): AgentCompactionDetail {
  const truncated = entry.summary.length > MAX_COMPACTION_SUMMARY_CHARS;
  return {
    summary: truncated ? entry.summary.slice(0, MAX_COMPACTION_SUMMARY_CHARS) : entry.summary,
    truncated,
    tokensBefore: entry.tokensBefore,
    ...(enrichment?.estimatedTokensAfter !== undefined
      ? { estimatedTokensAfter: enrichment.estimatedTokensAfter }
      : {}),
  };
}

function buildContextIndex(
  contextMessages: readonly AgentMessage[],
): (message: AgentMessage) => number | undefined {
  const byReference = new Map<AgentMessage, number>();
  const byRoleTimestamp = new Map<string, number[]>();
  contextMessages.forEach((message, index) => {
    byReference.set(message, index);
    const record = message as { role?: unknown; timestamp?: unknown };
    if (typeof record.role !== "string" || typeof record.timestamp !== "number") {
      return;
    }
    const key = `${record.role}:${record.timestamp}`;
    const list = byRoleTimestamp.get(key);
    if (list) {
      list.push(index);
    } else {
      byRoleTimestamp.set(key, [index]);
    }
  });
  return (message) => {
    const direct = byReference.get(message);
    if (direct !== undefined) {
      return direct;
    }
    const record = message as { role?: unknown; timestamp?: unknown };
    if (typeof record.role !== "string" || typeof record.timestamp !== "number") {
      return undefined;
    }
    const matches = byRoleTimestamp.get(`${record.role}:${record.timestamp}`);
    return matches && matches.length === 1 ? matches[0] : undefined;
  };
}
