import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadBaselineObservations, loadCases } from "./fixtures";
import { aggregateScores, scoreCase } from "./scoring";
import type { AgentEvalCase, AgentEvalObservation, AgentEvalRun, EvalCohort, EvalConfiguration } from "./types";

export const RUNNER_VERSION = "0.1.0";
export const BASELINE_REPETITIONS = 3;

export const BASELINE_CONFIGURATION: EvalConfiguration = {
  schemaVersion: 1,
  runnerVersion: RUNNER_VERSION,
  adapterId: "pho-code-current-deterministic-capture-v1",
  provider: "harness-test",
  model: "slice",
  thinkingLevel: "off",
  featureProfile: "deterministic-default",
  permissionProfile: "isolated-empty-manifest",
  contextSetting: "synthetic-fixture-only",
  repetitionCount: BASELINE_REPETITIONS,
  fixtureRevision: "v5-m0-2026-08-20.1",
  rubricVersion: "v5-m0-rubric.1",
};

export async function runBaseline(options: {
  cohorts: EvalCohort[];
  outputRoot?: string;
  generatedAt?: string;
}): Promise<{ outputRoot: string; files: string[]; runs: AgentEvalRun[] }> {
  const outputRoot = options.outputRoot
    ? path.resolve(options.outputRoot)
    : await mkdtemp(path.join(tmpdir(), "pho-agent-evals-"));
  await mkdir(outputRoot, { recursive: true });
  const observations = await loadBaselineObservations();
  return runEvaluation({
    ...options,
    configuration: BASELINE_CONFIGURATION,
    observe: (fixture) => {
      const observation = observations.get(fixture.id);
      if (!observation) throw new Error(`Missing baseline observation for ${fixture.id}.`);
      return observation;
    },
  });
}

export async function runEvaluation(options: {
  cohorts: EvalCohort[];
  configuration: EvalConfiguration;
  observe: (fixture: AgentEvalCase, repetition: number) => Promise<AgentEvalObservation> | AgentEvalObservation;
  outputRoot?: string;
  generatedAt?: string;
}): Promise<{ outputRoot: string; files: string[]; runs: AgentEvalRun[] }> {
  const outputRoot = options.outputRoot
    ? path.resolve(options.outputRoot)
    : await mkdtemp(path.join(tmpdir(), "pho-agent-evals-"));
  await mkdir(outputRoot, { recursive: true });
  const runs: AgentEvalRun[] = [];
  const files: string[] = [];

  for (const cohort of options.cohorts) {
    const fixtures = await loadCases(cohort);
    const fixtureChecksum = sha256(stableJson(fixtures));
    for (let repetition = 1; repetition <= BASELINE_REPETITIONS; repetition += 1) {
      const observations = await Promise.all(
        fixtures.map((fixture) => options.observe(fixture, repetition)),
      );
      const caseScores = fixtures.map((fixture, index) => scoreCase(fixture, observations[index]!));
      const runId = randomUUID();
      const run: AgentEvalRun = {
        schemaVersion: 1,
        runId,
        generatedAt: options.generatedAt ?? new Date().toISOString(),
        cohort,
        configuration: options.configuration,
        configurationFingerprint: sha256(stableJson(options.configuration)),
        fixtureChecksum,
        repetition,
        caseScores,
        metrics: aggregateScores(caseScores),
      };
      const file = path.join(outputRoot, `${cohort}-${repetition}-${runId}.json`);
      await writeFile(file, `${JSON.stringify(run, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      runs.push(run);
      files.push(file);
    }
  }
  return { outputRoot, files, runs };
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
