import { describe, expect, test } from "bun:test";
import {
  isAgentApprovalDecision,
  isAgentApprovalSessionState,
} from "../src/approval";

describe("approval protocol", () => {
  test("strictly validates reviewer and owner decisions", () => {
    expect(isAgentApprovalDecision({ outcome: "allow-once" })).toBe(true);
    expect(isAgentApprovalDecision({ outcome: "allow-session" })).toBe(false);
    expect(isAgentApprovalDecision({ outcome: "allow-session" }, { allowSession: true })).toBe(true);
    expect(isAgentApprovalDecision({ outcome: "deny", rationale: "No." })).toBe(true);
    expect(isAgentApprovalDecision({ outcome: "deny", extra: true })).toBe(false);
    expect(isAgentApprovalDecision({ outcome: "allow-once", rationale: "x".repeat(1_001) })).toBe(false);
    expect(isAgentApprovalDecision(Object.create({ outcome: "deny" }))).toBe(false);
  });

  test("validates bounded authoritative session state", () => {
    expect(
      isAgentApprovalSessionState({
        mode: "auto",
        reviewerState: "reviewing",
        policyGeneration: 2,
        activeGrantCount: 1,
        circuitOpen: false,
      }),
    ).toBe(true);
    expect(
      isAgentApprovalSessionState({
        mode: "full",
        reviewerState: "none",
        policyGeneration: -1,
        activeGrantCount: 0,
        circuitOpen: false,
      }),
    ).toBe(false);
  });
});
