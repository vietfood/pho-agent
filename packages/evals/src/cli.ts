import { readFile } from "node:fs/promises";
import { runBaseline, sha256 } from "./runner";
import type { EvalCohort } from "./types";

const args = process.argv.slice(2);
const cohortArgument = valueAfter(args, "--cohort") ?? "all";
const outputRoot = valueAfter(args, "--output");
const cohorts: EvalCohort[] =
  cohortArgument === "all"
    ? ["development", "holdout"]
    : cohortArgument === "development" || cohortArgument === "holdout"
      ? [cohortArgument]
      : fail(`Unknown cohort ${cohortArgument}.`);

const result = await runBaseline({ cohorts, ...(outputRoot ? { outputRoot } : {}) });
const files = await Promise.all(
  result.files.map(async (file) => ({ file, sha256: sha256(await readFile(file, "utf8")) })),
);
process.stdout.write(
  `${JSON.stringify(
    {
      outputRoot: result.outputRoot,
      files,
      runs: result.runs.map(({ runId, cohort, repetition, configurationFingerprint, fixtureChecksum, metrics }) => ({
        runId,
        cohort,
        repetition,
        configurationFingerprint,
        fixtureChecksum,
        metrics,
      })),
    },
    null,
    2,
  )}\n`,
);

function valueAfter(values: string[], flag: string): string | undefined {
  const index = values.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  const value = values[index + 1];
  if (!value || value.startsWith("--")) {
    fail(`${flag} requires a value.`);
  }
  return value;
}

function fail(message: string): never {
  throw new Error(message);
}
