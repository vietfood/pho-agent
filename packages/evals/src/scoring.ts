import type {
  AgentEvalCase,
  AgentEvalCaseScore,
  AgentEvalMetrics,
  AgentEvalObservation,
} from "./types";

export function scoreCase(fixture: AgentEvalCase, observation: AgentEvalObservation): AgentEvalCaseScore {
  if (fixture.id !== observation.caseId) {
    throw new Error(`Observation ${observation.caseId} does not belong to case ${fixture.id}.`);
  }

  const evidenceById = new Map(fixture.setup.evidence.map((item) => [item.id, item]));
  const selected = new Set(observation.selectedEvidenceIds);
  for (const id of selected) {
    if (!evidenceById.has(id)) {
      throw new Error(`Observation ${fixture.id} selected unknown evidence ${id}.`);
    }
  }

  const checks = fixture.acceptanceChecks.map(({ id }) => {
    const result = observation.acceptanceCheckResults[id];
    if (typeof result !== "boolean") {
      throw new Error(`Observation ${fixture.id} omitted acceptance check ${id}.`);
    }
    return result;
  });
  const supportedEvidence = new Set(observation.selectedEvidenceIds);
  const unsupportedClaimCount = observation.claims.filter(
    ({ supportingEvidenceIds }) =>
      supportingEvidenceIds.length === 0 || supportingEvidenceIds.some((id) => !supportedEvidence.has(id)),
  ).length;
  const passedVerification = observation.verificationClaims.filter(({ outcome }) => outcome === "passed");

  return {
    caseId: fixture.id,
    taskChecksPassed: checks.filter(Boolean).length,
    taskChecksTotal: checks.length,
    requiredEvidenceSelected: fixture.requiredEvidenceIds.filter((id) => selected.has(id)).length,
    requiredEvidenceTotal: fixture.requiredEvidenceIds.length,
    usefulEvidenceSelected: observation.selectedEvidenceIds.filter((id) => evidenceById.get(id)?.useful === true).length,
    evidenceSelected: observation.selectedEvidenceIds.length,
    forbiddenEvidenceSelected: fixture.forbiddenEvidenceIds.filter((id) => selected.has(id)).length,
    forbiddenEvidenceTotal: fixture.forbiddenEvidenceIds.length,
    unsupportedClaimCount,
    verificationFalsePasses: passedVerification.filter(({ authoritativeRecordIds }) => authoritativeRecordIds.length === 0).length,
    verificationPassClaims: passedVerification.length,
    criteriaAssessed: new Set(observation.assessedCriterionIds).size,
    criteriaTotal: fixture.criterionIds.length,
    recoveryPassed: fixture.expectsRecovery && observation.recoveredFromContradiction ? 1 : 0,
    recoveryExpected: fixture.expectsRecovery ? 1 : 0,
    efficiency: observation.efficiency,
  };
}

export function aggregateScores(scores: AgentEvalCaseScore[]): AgentEvalMetrics {
  const totals = scores.reduce(
    (sum, score) => ({
      taskChecksPassed: sum.taskChecksPassed + score.taskChecksPassed,
      taskChecksTotal: sum.taskChecksTotal + score.taskChecksTotal,
      requiredEvidenceSelected: sum.requiredEvidenceSelected + score.requiredEvidenceSelected,
      requiredEvidenceTotal: sum.requiredEvidenceTotal + score.requiredEvidenceTotal,
      usefulEvidenceSelected: sum.usefulEvidenceSelected + score.usefulEvidenceSelected,
      evidenceSelected: sum.evidenceSelected + score.evidenceSelected,
      forbiddenEvidenceSelected: sum.forbiddenEvidenceSelected + score.forbiddenEvidenceSelected,
      forbiddenEvidenceTotal: sum.forbiddenEvidenceTotal + score.forbiddenEvidenceTotal,
      unsupportedClaimCount: sum.unsupportedClaimCount + score.unsupportedClaimCount,
      verificationFalsePasses: sum.verificationFalsePasses + score.verificationFalsePasses,
      verificationPassClaims: sum.verificationPassClaims + score.verificationPassClaims,
      criteriaAssessed: sum.criteriaAssessed + score.criteriaAssessed,
      criteriaTotal: sum.criteriaTotal + score.criteriaTotal,
      recoveryPassed: sum.recoveryPassed + score.recoveryPassed,
      recoveryExpected: sum.recoveryExpected + score.recoveryExpected,
      toolCalls: sum.toolCalls + score.efficiency.toolCalls,
      injectedCharacters: sum.injectedCharacters + score.efficiency.injectedCharacters,
      estimatedTokens: sum.estimatedTokens + score.efficiency.estimatedTokens,
      latencyMs: sum.latencyMs + score.efficiency.latencyMs,
      providerUsage: sum.providerUsage + score.efficiency.providerUsage,
      providerCostUsd: sum.providerCostUsd + score.efficiency.providerCostUsd,
    }),
    {
      taskChecksPassed: 0,
      taskChecksTotal: 0,
      requiredEvidenceSelected: 0,
      requiredEvidenceTotal: 0,
      usefulEvidenceSelected: 0,
      evidenceSelected: 0,
      forbiddenEvidenceSelected: 0,
      forbiddenEvidenceTotal: 0,
      unsupportedClaimCount: 0,
      verificationFalsePasses: 0,
      verificationPassClaims: 0,
      criteriaAssessed: 0,
      criteriaTotal: 0,
      recoveryPassed: 0,
      recoveryExpected: 0,
      toolCalls: 0,
      injectedCharacters: 0,
      estimatedTokens: 0,
      latencyMs: 0,
      providerUsage: 0,
      providerCostUsd: 0,
    },
  );

  return {
    taskSuccess: ratio(totals.taskChecksPassed, totals.taskChecksTotal) ?? 0,
    criticalEvidenceRecall: ratio(totals.requiredEvidenceSelected, totals.requiredEvidenceTotal),
    evidencePrecision: ratio(totals.usefulEvidenceSelected, totals.evidenceSelected),
    forbiddenEvidenceRate: ratio(totals.forbiddenEvidenceSelected, totals.forbiddenEvidenceTotal) ?? 0,
    unsupportedClaimCount: totals.unsupportedClaimCount,
    verificationFalsePassRate: ratio(totals.verificationFalsePasses, totals.verificationPassClaims) ?? 0,
    criterionCoverage: ratio(totals.criteriaAssessed, totals.criteriaTotal),
    recoveryQuality: ratio(totals.recoveryPassed, totals.recoveryExpected),
    efficiency: {
      toolCalls: totals.toolCalls,
      injectedCharacters: totals.injectedCharacters,
      estimatedTokens: totals.estimatedTokens,
      latencyMs: totals.latencyMs,
      providerUsage: totals.providerUsage,
      providerCostUsd: totals.providerCostUsd,
    },
  };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}
