import { describe, expect, test } from "bun:test";
import {
  TASK_BRIEF_MAX_BYTES,
  normalizeTaskBriefContent,
  type TaskBriefContent,
} from "../src/task";

const valid = (overrides: Partial<TaskBriefContent> = {}): TaskBriefContent => ({
  objective: "Ship the task intelligence slice",
  constraints: ["Keep protocol values JSON-safe"],
  acceptanceCriteria: [
    { id: "state", text: "Task state restores from the active branch" },
    { id: "honesty", text: "Completion never fabricates a pass" },
  ],
  assumptions: [],
  openQuestions: [],
  nonGoals: ["Do not replace Plan or todos"],
  ...overrides,
});

describe("Task Brief protocol", () => {
  test("normalizes valid content without merging task authorities", () => {
    expect(normalizeTaskBriefContent(valid())).toEqual(valid());
    expect(normalizeTaskBriefContent(valid({ acceptanceCriteria: [] }), "draft").acceptanceCriteria).toEqual([]);
  });

  test("rejects duplicate criterion identity and normalized text", () => {
    expect(() => normalizeTaskBriefContent(valid({
      acceptanceCriteria: [
        { id: "one", text: "Exact result" },
        { id: "one", text: "Different result" },
      ],
    }))).toThrow("Duplicate Task criterion id");
    expect(() => normalizeTaskBriefContent(valid({
      acceptanceCriteria: [
        { id: "one", text: "Exact   result" },
        { id: "two", text: " exact result " },
      ],
    }))).toThrow("Duplicate Task criterion text");
  });

  test("enforces active/draft and serialized byte bounds", () => {
    expect(() => normalizeTaskBriefContent(valid({ acceptanceCriteria: [] }))).toThrow("requires at least one");
    expect(() => normalizeTaskBriefContent(valid({ objective: "x".repeat(4_097) }))).toThrow("1-4096");
    const oversized = valid({
      constraints: Array.from({ length: 32 }, (_, index) => `${index}:${"x".repeat(1_020)}`),
      assumptions: Array.from({ length: 32 }, (_, index) => `${index}:${"y".repeat(1_020)}`),
      acceptanceCriteria: Array.from({ length: 32 }, (_, index) => ({
        id: `criterion-${index}`,
        text: `${index}:${"z".repeat(1_020)}`,
      })),
    });
    expect(() => normalizeTaskBriefContent(oversized)).toThrow(`${TASK_BRIEF_MAX_BYTES} bytes`);
  });
});
