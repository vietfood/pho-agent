import { describe, expect, test } from "bun:test";
import type {
  CompletionAssessment,
  TaskBriefContent,
  VerificationRecord,
} from "@pho-agent/protocol";
import {
  acceptCompletionGaps,
  appendCompletionAssessment,
  appendTaskBrief,
  appendVerificationRecord,
  buildCompletionAssessment,
  projectAgentTask,
  reopenTaskBrief,
  resetTaskBrief,
  type TaskEntryStore,
} from "../src/task-state";

const key = { scopeId: "workspace", sessionId: "session" };
const content: TaskBriefContent = {
  objective: "Finish V5",
  constraints: ["Preserve product boundaries"],
  acceptanceCriteria: [
    { id: "tests", text: "Deterministic tests pass" },
    { id: "owner", text: "Owner can verify later" },
  ],
  assumptions: [],
  openQuestions: [],
  nonGoals: [],
};

function memoryStore(): TaskEntryStore & { entries: unknown[] } {
  const entries: unknown[] = [];
  return {
    entries,
    appendCustomEntry(customType, data) {
      entries.push({ type: "custom", customType, data });
      return `entry-${entries.length}`;
    },
    getBranch: () => entries,
  };
}

describe("append-only task state", () => {
  test("uses compare-and-set, reset tombstones, and branch ownership", () => {
    const store = memoryStore();
    const first = appendTaskBrief(store, key, content, {
      id: () => "r1",
      now: () => "2026-09-01T00:00:00.000Z",
      updatedBy: "owner",
    });
    expect(projectAgentTask(store.entries, key).brief?.revision).toBe("r1");
    expect(projectAgentTask(store.entries, { ...key, sessionId: "other" }).brief).toBeUndefined();
    expect(() => appendTaskBrief(store, key, content, {
      id: () => "r2",
      now: () => "2026-09-01T00:00:01.000Z",
      updatedBy: "owner",
      expectedRevision: "stale",
    })).toThrow("changed before");
    resetTaskBrief(store, key, first.revision);
    expect(projectAgentTask(store.entries, key).brief).toBeUndefined();
    expect(store.entries).toHaveLength(2);
  });

  test("requires current compatible passed verification", () => {
    const store = memoryStore();
    const brief = appendTaskBrief(store, key, content, {
      id: () => "r1",
      now: () => "2026-09-01T00:00:00.000Z",
      updatedBy: "agent",
    });
    const passed: VerificationRecord = {
      id: "v1",
      sourceAdapterId: "test",
      sourceCallId: "call-1",
      criterionId: "tests",
      outcome: "passed",
      summary: "Focused tests passed",
      freshness: "current",
      observedAt: "2026-09-01T00:00:01.000Z",
    };
    store.entries.push({
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash" }] },
    });
    appendVerificationRecord(store, key, passed);
    expect(() => buildCompletionAssessment({
      brief,
      ledger: projectAgentTask(store.entries, key).verification,
      criteria: [
        { criterionId: "tests", outcome: "passed", verificationIds: [] },
        { criterionId: "owner", outcome: "unverified", verificationIds: [], note: "Owner check remains" },
      ],
      id: "c-bad",
      createdAt: "2026-09-01T00:00:02.000Z",
    })).toThrow("requires current passed verification");
    const completion = buildCompletionAssessment({
      brief,
      ledger: projectAgentTask(store.entries, key).verification,
      criteria: [
        { criterionId: "tests", outcome: "passed", verificationIds: ["v1"] },
        { criterionId: "owner", outcome: "unverified", verificationIds: [], note: "Owner check remains" },
      ],
      id: "c1",
      createdAt: "2026-09-01T00:00:02.000Z",
    });
    appendCompletionAssessment(store, key, completion);
    expect(projectAgentTask(store.entries, key).completion?.status).toBe("incomplete");
    const accepted = acceptCompletionGaps(completion, "2026-09-01T00:00:03.000Z");
    appendCompletionAssessment(store, key, accepted);
    expect(projectAgentTask(store.entries, key).brief?.status).toBe("completed");
  });

  test("marks source-linked verification stale when its tool call is absent", () => {
    const store = memoryStore();
    appendVerificationRecord(store, key, {
      id: "v1",
      sourceAdapterId: "test",
      sourceCallId: "missing-call",
      outcome: "passed",
      summary: "Looks passed",
      freshness: "current",
      observedAt: "now",
    });
    expect(projectAgentTask(store.entries, key).verification.records[0]).toMatchObject({
      id: "v1",
      freshness: "stale",
      invalidationReason: "The authoritative source tool call is absent from the active branch.",
    });
  });

  test("invalidates owner-accepted gaps when linked passed evidence leaves the active branch", () => {
    const store = memoryStore();
    const brief = appendTaskBrief(store, key, content, {
      id: () => "r1",
      now: () => "now",
      updatedBy: "owner",
    });
    store.entries.push({
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash" }] },
    });
    appendVerificationRecord(store, key, {
      id: "v1",
      sourceAdapterId: "test",
      sourceCallId: "call-1",
      criterionId: "tests",
      outcome: "passed",
      summary: "passed",
      freshness: "current",
      observedAt: "now",
    });
    const completion = buildCompletionAssessment({
      brief,
      ledger: projectAgentTask(store.entries, key).verification,
      criteria: [
        { criterionId: "tests", outcome: "passed", verificationIds: ["v1"] },
        { criterionId: "owner", outcome: "unverified", verificationIds: [], note: "Owner check remains" },
      ],
      id: "c1",
      createdAt: "now",
    });
    appendCompletionAssessment(store, key, acceptCompletionGaps(completion, "later"));
    expect(projectAgentTask(store.entries, key).completion?.status).toBe("accepted_with_gaps");

    appendVerificationRecord(store, key, {
      id: "v2",
      sourceAdapterId: "owner",
      criterionId: "owner",
      outcome: "failed",
      summary: "Owner found a regression",
      freshness: "current",
      observedAt: "after",
    });
    expect(projectAgentTask(store.entries, key).completion).toMatchObject({ status: "incomplete" });
    expect(projectAgentTask(store.entries, key).brief?.status).toBe("active");

    store.entries.pop();
    store.entries.splice(1, 1);
    expect(projectAgentTask(store.entries, key).completion).toMatchObject({ status: "incomplete" });
    expect(projectAgentTask(store.entries, key).brief?.status).toBe("active");
  });

  test("rejects malformed persisted evidence and completion instead of trusting casts", () => {
    const store = memoryStore();
    appendTaskBrief(store, key, content, { id: () => "r1", now: () => "now", updatedBy: "owner" });
    store.entries.push({
      type: "custom",
      customType: "pho-agent.evidence-pack",
      data: {
        ...key,
        value: {
          id: "pack",
          runId: "run",
          generatedAt: "now",
          items: [{ id: "bad", relevance: 2 }],
          omittedCount: 0,
          failedProviders: [],
          estimatedTokens: 0,
          characterCount: 0,
          truncated: false,
        },
      },
    }, {
      type: "custom",
      customType: "pho-agent.completion",
      data: {
        ...key,
        value: {
          id: "completion",
          briefRevision: "r1",
          status: "accepted_with_gaps",
          criteria: [{ criterionId: "tests", outcome: "failed", verificationIds: [], note: "failed" }],
          createdAt: "now",
          acceptedByOwnerAt: "later",
        },
      },
    });
    const projected = projectAgentTask(store.entries, key);
    expect(projected.evidence).toBeUndefined();
    expect(projected.completion).toBeUndefined();
    expect(projected.brief?.status).toBe("active");
  });

  test("rejects accepting failures and invalidates completion on brief revision", () => {
    const failed: CompletionAssessment = {
      id: "c1",
      briefRevision: "r1",
      status: "incomplete",
      criteria: [{ criterionId: "tests", outcome: "failed", verificationIds: ["v1"], note: "Failed" }],
      createdAt: "2026-09-01T00:00:00.000Z",
    };
    expect(() => acceptCompletionGaps(failed, "later")).toThrow("cannot be accepted");
    const store = memoryStore();
    const first = appendTaskBrief(store, key, content, {
      id: () => "r1",
      now: () => "now",
      updatedBy: "owner",
    });
    appendCompletionAssessment(store, key, {
      ...failed,
      status: "ready",
      criteria: [],
    });
    appendTaskBrief(store, key, { ...content, objective: "Changed" }, {
      id: () => "r2",
      now: () => "later",
      updatedBy: "owner",
      expectedRevision: first.revision,
    });
    expect(projectAgentTask(store.entries, key).completion).toBeUndefined();
  });

  test("reopens a completed projection with a new revision", () => {
    const store = memoryStore();
    const brief = appendTaskBrief(store, key, content, {
      id: () => "r1",
      now: () => "now",
      updatedBy: "owner",
    });
    const records = content.acceptanceCriteria.map((criterion, index): VerificationRecord => ({
      id: `v${index}`,
      sourceAdapterId: "test",
      criterionId: criterion.id,
      outcome: "passed",
      summary: "passed",
      freshness: "current",
      observedAt: "now",
    }));
    records.forEach((record) => appendVerificationRecord(store, key, record));
    appendCompletionAssessment(store, key, buildCompletionAssessment({
      brief,
      ledger: projectAgentTask(store.entries, key).verification,
      criteria: records.map((record) => ({ criterionId: record.criterionId!, outcome: "passed", verificationIds: [record.id] })),
      id: "c1",
      createdAt: "now",
    }));
    expect(projectAgentTask(store.entries, key).brief?.status).toBe("completed");
    const reopened = reopenTaskBrief(store, key, { id: () => "r2", now: () => "later" });
    expect(reopened.status).toBe("active");
    expect(projectAgentTask(store.entries, key).completion).toBeUndefined();
  });
});
