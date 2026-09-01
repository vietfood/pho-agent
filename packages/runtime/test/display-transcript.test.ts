import { describe, expect, test } from "bun:test";
import type { AgentMessage, CompactionEntry, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import {
  collectDisplayTranscriptItems,
  compactionDetailFromEntry,
  legacyDisplayIdCandidates,
  projectCompactionBoundary,
} from "../src/display-transcript";

function userMessage(text: string, timestamp: number): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp } as AgentMessage;
}

function assistantMessage(text: string, timestamp: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp,
  } as unknown as AgentMessage;
}

function messageEntry(id: string, parentId: string | null, message: AgentMessage, timestamp: string): SessionMessageEntry {
  return { type: "message", id, parentId, timestamp, message };
}

function compactionEntry(id: string, parentId: string | null, overrides: Partial<CompactionEntry> = {}): CompactionEntry {
  return {
    type: "compaction",
    id,
    parentId,
    timestamp: "2026-09-01T01:00:00.000Z",
    summary: "Summary of earlier work.",
    firstKeptEntryId: "e3",
    tokensBefore: 12_345,
    ...overrides,
  };
}

describe("collectDisplayTranscriptItems", () => {
  test("keeps full branch order with compaction boundaries inline", () => {
    const m1 = userMessage("first", 1000);
    const m2 = assistantMessage("answer", 1001);
    const m3 = userMessage("second", 1002);
    const branch: SessionEntry[] = [
      messageEntry("e1", null, m1, "2026-09-01T00:00:01.000Z"),
      messageEntry("e2", "e1", m2, "2026-09-01T00:00:02.000Z"),
      compactionEntry("c1", "e2"),
      messageEntry("e3", "c1", m3, "2026-09-01T01:00:01.000Z"),
    ];
    const items = collectDisplayTranscriptItems(branch, [m3]);
    expect(items.map((item) => item.kind)).toEqual(["message", "message", "compaction", "message"]);
    const ids = items.map((item) => item.entry.id);
    expect(ids).toEqual(["e1", "e2", "c1", "e3"]);
  });

  test("assigns no-compaction context indices that ignore compaction entries", () => {
    const m1 = userMessage("first", 1000);
    const m2 = assistantMessage("answer", 1001);
    const m3 = userMessage("second", 1002);
    const branch: SessionEntry[] = [
      messageEntry("e1", null, m1, "2026-09-01T00:00:01.000Z"),
      messageEntry("e2", "e1", m2, "2026-09-01T00:00:02.000Z"),
      compactionEntry("c1", "e2"),
      messageEntry("e3", "c1", m3, "2026-09-01T01:00:01.000Z"),
    ];
    const items = collectDisplayTranscriptItems(branch, []);
    const messages = items.filter((item) => item.kind === "message");
    expect(messages.map((item) => item.branchContextIndex)).toEqual([0, 1, 2]);
  });

  test("counts custom_message entries toward the legacy context index", () => {
    const m1 = userMessage("first", 1000);
    const m2 = userMessage("second", 1002);
    const branch: SessionEntry[] = [
      messageEntry("e1", null, m1, "2026-09-01T00:00:01.000Z"),
      {
        type: "custom_message",
        id: "cm1",
        parentId: "e1",
        timestamp: "2026-09-01T00:00:01.500Z",
        customType: "kickoff",
        content: "hidden kickoff",
        display: false,
      },
      messageEntry("e2", "cm1", m2, "2026-09-01T00:00:02.000Z"),
    ];
    const items = collectDisplayTranscriptItems(branch, []);
    expect(items.map((item) => item.kind)).toEqual(["message", "message"]);
    const second = items[1];
    expect(second.kind === "message" && second.branchContextIndex).toBe(2);
  });

  test("matches current context indices by reference and by role+timestamp", () => {
    const m1 = userMessage("first", 1000);
    const m2 = userMessage("second", 1002);
    const branch: SessionEntry[] = [
      messageEntry("e1", null, m1, "2026-09-01T00:00:01.000Z"),
      messageEntry("e2", "e1", m2, "2026-09-01T00:00:02.000Z"),
    ];
    // Post-compaction context: summary message + kept message (same reference).
    const summaryMessage = userMessage("summary", 999);
    const items = collectDisplayTranscriptItems(branch, [summaryMessage, m2]);
    const [first, second] = items;
    expect(first.kind === "message" && first.contextMessageIndex).toBe(undefined);
    expect(second.kind === "message" && second.contextMessageIndex).toBe(1);
  });
});

describe("legacyDisplayIdCandidates", () => {
  test("produces the pre-compaction id and the current-context id", () => {
    const m1 = userMessage("first", 1000);
    const kept = userMessage("kept", 1001);
    const m2 = userMessage("second", 1002);
    const branch: SessionEntry[] = [
      messageEntry("e1", null, m1, "2026-09-01T00:00:01.000Z"),
      messageEntry("e2", "e1", kept, "2026-09-01T00:00:02.000Z"),
      compactionEntry("c1", "e2"),
      messageEntry("e3", "c1", m2, "2026-09-01T01:00:02.000Z"),
    ];
    // Post-compaction context: summary + kept entry + post-boundary message.
    const summaryMessage = userMessage("summary", 999);
    const items = collectDisplayTranscriptItems(branch, [summaryMessage, kept, m2]);
    const last = items[3];
    if (last.kind !== "message") {
      throw new Error("expected message item");
    }
    expect(last.branchContextIndex).toBe(2);
    expect(last.contextMessageIndex).toBe(2);
    expect(legacyDisplayIdCandidates(last)).toEqual(["user:1002:2"]);
    const keptItem = items[1];
    if (keptItem.kind !== "message") {
      throw new Error("expected message item");
    }
    expect(keptItem.branchContextIndex).toBe(1);
    expect(keptItem.contextMessageIndex).toBe(1);
    expect(legacyDisplayIdCandidates(keptItem)).toEqual(["user:1001:1"]);
  });

  test("differs when compaction shifted the current context index", () => {
    const m1 = userMessage("first", 1000);
    const m2 = userMessage("second", 1002);
    const branch: SessionEntry[] = [
      messageEntry("e1", null, m1, "2026-09-01T00:00:01.000Z"),
      compactionEntry("c1", "e1"),
      messageEntry("e2", "c1", m2, "2026-09-01T01:00:02.000Z"),
    ];
    const summaryMessage = userMessage("summary", 999);
    // Context holds summary + an extra kept message + m2, so m2's current
    // context index (2) differs from its no-compaction index (1).
    const extra = userMessage("extra", 998);
    const items = collectDisplayTranscriptItems(branch, [summaryMessage, extra, m2]);
    const last = items[2];
    if (last.kind !== "message") {
      throw new Error("expected message item");
    }
    expect(last.branchContextIndex).toBe(1);
    expect(last.contextMessageIndex).toBe(2);
    expect(legacyDisplayIdCandidates(last)).toEqual(["user:1002:1", "user:1002:2"]);
  });

  test("omits the duplicate when both indices agree", () => {
    const m1 = userMessage("first", 1000);
    const branch: SessionEntry[] = [messageEntry("e1", null, m1, "2026-09-01T00:00:01.000Z")];
    const items = collectDisplayTranscriptItems(branch, [m1]);
    const first = items[0];
    if (first.kind !== "message") {
      throw new Error("expected message item");
    }
    expect(legacyDisplayIdCandidates(first)).toEqual(["user:1000:0"]);
  });
});

describe("projectCompactionBoundary", () => {
  test("projects entry fields and applies live enrichment", () => {
    const boundary = projectCompactionBoundary(compactionEntry("c1", "e2"), {
      reason: "threshold",
      estimatedTokensAfter: 3_000,
      willRetry: false,
    });
    expect(boundary).toEqual({
      kind: "compaction",
      id: "c1",
      createdAt: "2026-09-01T01:00:00.000Z",
      reason: "threshold",
      tokensBefore: 12_345,
      estimatedTokensAfter: 3_000,
      hasSummary: true,
      fromHook: false,
    });
  });

  test("marks empty summaries and hook-owned entries", () => {
    const boundary = projectCompactionBoundary(
      compactionEntry("c1", "e2", { summary: "  ", fromHook: true }),
    );
    expect(boundary.hasSummary).toBe(false);
    expect(boundary.fromHook).toBe(true);
    expect(boundary.reason).toBeUndefined();
  });
});

describe("compactionDetailFromEntry", () => {
  test("passes through bounded summaries", () => {
    const detail = compactionDetailFromEntry(compactionEntry("c1", "e2"));
    expect(detail).toEqual({ summary: "Summary of earlier work.", truncated: false, tokensBefore: 12_345 });
  });

  test("truncates oversized summaries", () => {
    const detail = compactionDetailFromEntry(compactionEntry("c1", "e2", { summary: "s".repeat(70 * 1024) }));
    expect(detail.truncated).toBe(true);
    expect(detail.summary.length).toBe(64 * 1024);
  });
});
