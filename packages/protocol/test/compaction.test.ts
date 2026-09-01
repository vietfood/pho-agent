import { describe, expect, test } from "bun:test";
import {
  AGENT_COMPACTION_OUTCOMES,
  AGENT_COMPACTION_REASONS,
  AGENT_COMPACTION_STATUSES,
  MAX_COMPACTION_ERROR_CHARS,
  MAX_COMPACTION_SUMMARY_CHARS,
  idleAgentCompactionState,
  isAgentCompactionBoundary,
  isAgentCompactionDetail,
  isAgentCompactionOutcome,
  isAgentCompactionReason,
  isAgentCompactionState,
  jsonRoundTrip,
  sanitizeCompactionError,
  type AgentCompactionBoundary,
  type AgentCompactionDetail,
  type AgentCompactionState,
} from "../src";

describe("agent compaction contracts", () => {
  test("reason, status, and outcome vocabularies stay pinned", () => {
    expect(AGENT_COMPACTION_REASONS).toEqual(["manual", "threshold", "overflow"]);
    expect(AGENT_COMPACTION_STATUSES).toEqual(["idle", "compacting"]);
    expect(AGENT_COMPACTION_OUTCOMES).toEqual(["completed", "cancelled", "failed"]);
  });

  test("idle state is the default and validates", () => {
    const state = idleAgentCompactionState();
    expect(state).toEqual({ status: "idle", cancelable: false });
    expect(isAgentCompactionState(state)).toBe(true);
  });

  test("compacting state requires reason and startedAt", () => {
    const compacting: AgentCompactionState = {
      status: "compacting",
      reason: "manual",
      startedAt: "2026-09-01T00:00:00.000Z",
      cancelable: true,
    };
    expect(isAgentCompactionState(compacting)).toBe(true);
    expect(isAgentCompactionState({ status: "compacting", cancelable: true })).toBe(false);
    expect(isAgentCompactionState({ status: "compacting", reason: "manual", cancelable: true })).toBe(false);
    expect(
      isAgentCompactionState({ status: "compacting", reason: "bogus", startedAt: "x", cancelable: false }),
    ).toBe(false);
  });

  test("state validator rejects malformed values", () => {
    expect(isAgentCompactionState(null)).toBe(false);
    expect(isAgentCompactionState("idle")).toBe(false);
    expect(isAgentCompactionState({ status: "idle" })).toBe(false);
    expect(isAgentCompactionState({ status: "idle", cancelable: "yes" })).toBe(false);
    expect(isAgentCompactionState({ status: "idle", cancelable: false, startedAt: 7 })).toBe(false);
  });

  test("boundary round-trips as JSON-safe data", () => {
    const boundary: AgentCompactionBoundary = {
      kind: "compaction",
      id: "entry-1",
      createdAt: "2026-09-01T00:00:00.000Z",
      reason: "threshold",
      tokensBefore: 120_000,
      estimatedTokensAfter: 4_000,
      hasSummary: true,
      fromHook: false,
    };
    const roundTripped = jsonRoundTrip(boundary);
    expect(isAgentCompactionBoundary(roundTripped)).toBe(true);
    expect(roundTripped).toEqual(boundary);
  });

  test("boundary validator enforces required fields", () => {
    const base = {
      kind: "compaction",
      id: "entry-1",
      createdAt: "2026-09-01T00:00:00.000Z",
      tokensBefore: 10,
      hasSummary: true,
      fromHook: false,
    };
    expect(isAgentCompactionBoundary(base)).toBe(true);
    expect(isAgentCompactionBoundary({ ...base, kind: "message" })).toBe(false);
    expect(isAgentCompactionBoundary({ ...base, id: "" })).toBe(false);
    expect(isAgentCompactionBoundary({ ...base, tokensBefore: Number.NaN })).toBe(false);
    expect(isAgentCompactionBoundary({ ...base, reason: "other" })).toBe(false);
    expect(isAgentCompactionBoundary({ ...base, estimatedTokensAfter: "many" })).toBe(false);
  });

  test("detail round-trips and validates", () => {
    const detail: AgentCompactionDetail = {
      summary: "We did things.",
      truncated: false,
      tokensBefore: 42,
    };
    expect(isAgentCompactionDetail(jsonRoundTrip(detail))).toBe(true);
    expect(isAgentCompactionDetail({ summary: "x", truncated: false, tokensBefore: "42" })).toBe(false);
  });

  test("reason and outcome guards reject unknown values", () => {
    expect(isAgentCompactionReason("manual")).toBe(true);
    expect(isAgentCompactionReason("model")).toBe(false);
    expect(isAgentCompactionOutcome("cancelled")).toBe(true);
    expect(isAgentCompactionOutcome("exploded")).toBe(false);
  });

  test("error sanitizer flattens and bounds messages", () => {
    expect(sanitizeCompactionError("line one\nline two")).toBe("line one line two");
    const long = "x".repeat(MAX_COMPACTION_ERROR_CHARS * 2);
    const sanitized = sanitizeCompactionError(long);
    expect(sanitized.length).toBe(MAX_COMPACTION_ERROR_CHARS);
    expect(sanitized.endsWith("…")).toBe(true);
  });

  test("summary bound stays at 64 KiB", () => {
    expect(MAX_COMPACTION_SUMMARY_CHARS).toBe(64 * 1024);
  });
});
