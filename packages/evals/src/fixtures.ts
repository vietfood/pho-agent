import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvalCase, AgentEvalObservation, EvalCohort } from "./types";

export const EVAL_FIXTURES_ROOT = fileURLToPath(new URL("../fixtures/", import.meta.url));

export async function loadCases(cohort: EvalCohort): Promise<AgentEvalCase[]> {
  const value = await readJson(`${cohort}.json`);
  if (!Array.isArray(value)) {
    throw new Error(`${cohort} fixture must be an array.`);
  }
  const cases = value.map((item, index) => parseCase(item, `${cohort}[${index}]`));
  assertUnique(cases.map(({ id }) => id), `${cohort} case ids`);
  return cases;
}

export async function loadBaselineObservations(): Promise<Map<string, AgentEvalObservation>> {
  const value = await readJson("baseline-observations.json");
  if (!Array.isArray(value)) {
    throw new Error("baseline observations must be an array.");
  }
  const observations = value.map((item, index) => parseObservation(item, `baseline[${index}]`));
  assertUnique(observations.map(({ caseId }) => caseId), "baseline case ids");
  return new Map(observations.map((observation) => [observation.caseId, observation]));
}

async function readJson(name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(EVAL_FIXTURES_ROOT, name), "utf8"));
}

function parseCase(value: unknown, label: string): AgentEvalCase {
  const record = object(value, label);
  const setup = object(record.setup, `${label}.setup`);
  const rubric = object(record.rubric, `${label}.rubric`);
  const evidence = array(setup.evidence, `${label}.setup.evidence`).map((item, index) => {
    const entry = object(item, `${label}.setup.evidence[${index}]`);
    return {
      id: string(entry.id, `${label}.evidence.id`),
      content: string(entry.content, `${label}.evidence.content`),
      useful: boolean(entry.useful, `${label}.evidence.useful`),
      forbidden: boolean(entry.forbidden, `${label}.evidence.forbidden`),
    };
  });
  const acceptanceChecks = array(record.acceptanceChecks, `${label}.acceptanceChecks`).map((item, index) => {
    const check = object(item, `${label}.acceptanceChecks[${index}]`);
    return {
      id: string(check.id, `${label}.acceptanceChecks.id`),
      description: string(check.description, `${label}.acceptanceChecks.description`),
    };
  });
  const id = string(record.id, `${label}.id`);
  const fixtureRevision = string(record.fixtureRevision, `${label}.fixtureRevision`);
  const cohort = record.cohort;
  if (cohort !== "development" && cohort !== "holdout") {
    throw new Error(`${label}.cohort must be development or holdout.`);
  }
  const files = object(setup.files, `${label}.setup.files`);
  const parsedFiles = Object.fromEntries(
    Object.entries(files).map(([file, content]) => [file, string(content, `${label}.setup.files.${file}`)]),
  );
  const parsed = {
    id,
    fixtureRevision,
    cohort,
    prompt: string(record.prompt, `${label}.prompt`),
    setup: { files: parsedFiles, evidence },
    requiredEvidenceIds: strings(record.requiredEvidenceIds, `${label}.requiredEvidenceIds`),
    forbiddenEvidenceIds: strings(record.forbiddenEvidenceIds, `${label}.forbiddenEvidenceIds`),
    acceptanceChecks,
    criterionIds: strings(record.criterionIds, `${label}.criterionIds`),
    expectsRecovery: boolean(record.expectsRecovery, `${label}.expectsRecovery`),
    rubric: {
      taskOutcome: string(rubric.taskOutcome, `${label}.rubric.taskOutcome`),
      evidenceQuality: string(rubric.evidenceQuality, `${label}.rubric.evidenceQuality`),
      verificationHonesty: string(rubric.verificationHonesty, `${label}.rubric.verificationHonesty`),
      recovery: string(rubric.recovery, `${label}.rubric.recovery`),
    },
  } satisfies AgentEvalCase;
  validateCase(parsed, label);
  return parsed;
}

function validateCase(value: AgentEvalCase, label: string): void {
  const evidenceIds = value.setup.evidence.map(({ id }) => id);
  const evidenceIdSet = new Set(evidenceIds);
  assertUnique(evidenceIds, `${label} evidence ids`);
  assertUnique(value.acceptanceChecks.map(({ id }) => id), `${label} acceptance check ids`);
  assertUnique(value.criterionIds, `${label} criterion ids`);
  for (const id of [...value.requiredEvidenceIds, ...value.forbiddenEvidenceIds]) {
    if (!evidenceIdSet.has(id)) {
      throw new Error(`${label} references missing evidence ${id}.`);
    }
  }
}

function parseObservation(value: unknown, label: string): AgentEvalObservation {
  const record = object(value, label);
  const results = object(record.acceptanceCheckResults, `${label}.acceptanceCheckResults`);
  const efficiency = object(record.efficiency, `${label}.efficiency`);
  return {
    caseId: string(record.caseId, `${label}.caseId`),
    acceptanceCheckResults: Object.fromEntries(
      Object.entries(results).map(([id, result]) => [id, boolean(result, `${label}.acceptanceCheckResults.${id}`)]),
    ),
    selectedEvidenceIds: strings(record.selectedEvidenceIds, `${label}.selectedEvidenceIds`),
    claims: array(record.claims, `${label}.claims`).map((item, index) => {
      const claim = object(item, `${label}.claims[${index}]`);
      return {
        text: string(claim.text, `${label}.claims.text`),
        supportingEvidenceIds: strings(claim.supportingEvidenceIds, `${label}.claims.supportingEvidenceIds`),
      };
    }),
    verificationClaims: array(record.verificationClaims, `${label}.verificationClaims`).map((item, index) => {
      const claim = object(item, `${label}.verificationClaims[${index}]`);
      const outcome = claim.outcome;
      if (outcome !== "passed" && outcome !== "failed" && outcome !== "unverified") {
        throw new Error(`${label}.verificationClaims.outcome is invalid.`);
      }
      return {
        criterionId: string(claim.criterionId, `${label}.verificationClaims.criterionId`),
        outcome,
        authoritativeRecordIds: strings(
          claim.authoritativeRecordIds,
          `${label}.verificationClaims.authoritativeRecordIds`,
        ),
      };
    }),
    assessedCriterionIds: strings(record.assessedCriterionIds, `${label}.assessedCriterionIds`),
    recoveredFromContradiction: boolean(record.recoveredFromContradiction, `${label}.recoveredFromContradiction`),
    efficiency: {
      toolCalls: number(efficiency.toolCalls, `${label}.efficiency.toolCalls`),
      injectedCharacters: number(efficiency.injectedCharacters, `${label}.efficiency.injectedCharacters`),
      estimatedTokens: number(efficiency.estimatedTokens, `${label}.efficiency.estimatedTokens`),
      latencyMs: number(efficiency.latencyMs, `${label}.efficiency.latencyMs`),
      providerUsage: number(efficiency.providerUsage, `${label}.efficiency.providerUsage`),
      providerCostUsd: number(efficiency.providerCostUsd, `${label}.efficiency.providerCostUsd`),
    },
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function strings(value: unknown, label: string): string[] {
  return array(value, label).map((item, index) => string(item, `${label}[${index}]`));
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean.`);
  }
  return value;
}

function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number.`);
  }
  return value;
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must be unique.`);
  }
}
