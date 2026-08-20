export type EvalCohort = "development" | "holdout";

export interface EvalEvidenceItem {
  id: string;
  content: string;
  useful: boolean;
  forbidden: boolean;
}

export interface EvalAcceptanceCheck {
  id: string;
  description: string;
}

export interface AgentEvalCase {
  id: string;
  fixtureRevision: string;
  cohort: EvalCohort;
  prompt: string;
  setup: {
    files: Record<string, string>;
    evidence: EvalEvidenceItem[];
  };
  requiredEvidenceIds: string[];
  forbiddenEvidenceIds: string[];
  acceptanceChecks: EvalAcceptanceCheck[];
  criterionIds: string[];
  expectsRecovery: boolean;
  rubric: {
    taskOutcome: string;
    evidenceQuality: string;
    verificationHonesty: string;
    recovery: string;
  };
}

export interface EvalClaim {
  text: string;
  supportingEvidenceIds: string[];
}

export interface EvalVerificationClaim {
  criterionId: string;
  outcome: "passed" | "failed" | "unverified";
  authoritativeRecordIds: string[];
}

export interface AgentEvalObservation {
  caseId: string;
  acceptanceCheckResults: Record<string, boolean>;
  selectedEvidenceIds: string[];
  claims: EvalClaim[];
  verificationClaims: EvalVerificationClaim[];
  assessedCriterionIds: string[];
  recoveredFromContradiction: boolean;
  efficiency: {
    toolCalls: number;
    injectedCharacters: number;
    estimatedTokens: number;
    latencyMs: number;
    providerUsage: number;
    providerCostUsd: number;
  };
}

export interface EvalConfiguration {
  schemaVersion: 1;
  runnerVersion: string;
  adapterId: string;
  provider: string;
  model: string;
  thinkingLevel: string;
  featureProfile: string;
  permissionProfile: string;
  contextSetting: string;
  repetitionCount: number;
  fixtureRevision: string;
  rubricVersion: string;
}

export interface AgentEvalCaseScore {
  caseId: string;
  taskChecksPassed: number;
  taskChecksTotal: number;
  requiredEvidenceSelected: number;
  requiredEvidenceTotal: number;
  usefulEvidenceSelected: number;
  evidenceSelected: number;
  forbiddenEvidenceSelected: number;
  forbiddenEvidenceTotal: number;
  unsupportedClaimCount: number;
  verificationFalsePasses: number;
  verificationPassClaims: number;
  criteriaAssessed: number;
  criteriaTotal: number;
  recoveryPassed: number;
  recoveryExpected: number;
  efficiency: AgentEvalObservation["efficiency"];
}

export interface AgentEvalMetrics {
  taskSuccess: number;
  criticalEvidenceRecall: number | null;
  evidencePrecision: number | null;
  forbiddenEvidenceRate: number;
  unsupportedClaimCount: number;
  verificationFalsePassRate: number;
  criterionCoverage: number | null;
  recoveryQuality: number | null;
  efficiency: AgentEvalObservation["efficiency"];
}

export interface AgentEvalRun {
  schemaVersion: 1;
  runId: string;
  generatedAt: string;
  cohort: EvalCohort;
  configuration: EvalConfiguration;
  configurationFingerprint: string;
  fixtureChecksum: string;
  repetition: number;
  caseScores: AgentEvalCaseScore[];
  metrics: AgentEvalMetrics;
}
