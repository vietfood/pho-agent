import { describe, expect, test } from "bun:test";
import { aggregateScores, scoreCase } from "../src/scoring";
import type { AgentEvalCase, AgentEvalObservation } from "../src/types";

const fixture: AgentEvalCase = {
  id: "case",
  fixtureRevision: "1",
  cohort: "development",
  prompt: "prompt",
  setup: {
    files: {},
    evidence: [
      { id: "required", content: "required", useful: true, forbidden: false },
      { id: "forbidden", content: "forbidden", useful: false, forbidden: true },
    ],
  },
  requiredEvidenceIds: ["required"],
  forbiddenEvidenceIds: ["forbidden"],
  acceptanceChecks: [{ id: "check", description: "check" }],
  criterionIds: ["criterion"],
  expectsRecovery: true,
  rubric: { taskOutcome: "", evidenceQuality: "", verificationHonesty: "", recovery: "" },
};

const observation: AgentEvalObservation = {
  caseId: "case",
  acceptanceCheckResults: { check: true },
  selectedEvidenceIds: ["required"],
  claims: [{ text: "supported", supportingEvidenceIds: ["required"] }],
  verificationClaims: [{ criterionId: "criterion", outcome: "passed", authoritativeRecordIds: ["record"] }],
  assessedCriterionIds: ["criterion"],
  recoveredFromContradiction: true,
  efficiency: {
    toolCalls: 2,
    injectedCharacters: 20,
    estimatedTokens: 5,
    latencyMs: 10,
    providerUsage: 1,
    providerCostUsd: 0,
  },
};

describe("evaluation scoring", () => {
  test("scores task, evidence, verification, recovery, and efficiency", () => {
    const score = scoreCase(fixture, observation);
    expect(aggregateScores([score])).toEqual({
      taskSuccess: 1,
      criticalEvidenceRecall: 1,
      evidencePrecision: 1,
      forbiddenEvidenceRate: 0,
      unsupportedClaimCount: 0,
      verificationFalsePassRate: 0,
      criterionCoverage: 1,
      recoveryQuality: 1,
      efficiency: observation.efficiency,
    });
  });

  test("counts unsupported and false-pass claims", () => {
    const score = scoreCase(fixture, {
      ...observation,
      claims: [{ text: "unsupported", supportingEvidenceIds: [] }],
      verificationClaims: [{ criterionId: "criterion", outcome: "passed", authoritativeRecordIds: [] }],
    });
    const metrics = aggregateScores([score]);
    expect(metrics.unsupportedClaimCount).toBe(1);
    expect(metrics.verificationFalsePassRate).toBe(1);
  });

  test("rejects unknown evidence", () => {
    expect(() => scoreCase(fixture, { ...observation, selectedEvidenceIds: ["missing"] })).toThrow(
      "selected unknown evidence missing",
    );
  });
});
