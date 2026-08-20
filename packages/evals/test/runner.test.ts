import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BASELINE_CONFIGURATION, BASELINE_REPETITIONS, runBaseline, stableJson } from "../src/runner";

describe("baseline runner", () => {
  test("writes append-only fingerprinted development and holdout runs", async () => {
    const outputRoot = await mkdtemp(path.join(tmpdir(), "pho-agent-evals-test-"));
    const result = await runBaseline({
      cohorts: ["development", "holdout"],
      outputRoot,
      generatedAt: "2026-08-20T00:00:00.000Z",
    });

    expect(result.runs).toHaveLength(BASELINE_REPETITIONS * 2);
    expect(new Set(result.runs.map(({ configurationFingerprint }) => configurationFingerprint))).toHaveLength(1);
    expect(result.runs.every(({ configuration }) => configuration === BASELINE_CONFIGURATION)).toBe(true);
    expect(result.runs.every(({ metrics }) => metrics.forbiddenEvidenceRate === 0)).toBe(true);
    const first = JSON.parse(await readFile(result.files[0]!, "utf8"));
    expect(first.generatedAt).toBe("2026-08-20T00:00:00.000Z");

    await expect(writeFile(result.files[0]!, "overwrite", { flag: "wx" })).rejects.toThrow();
  });

  test("canonicalizes objects for stable fingerprints", () => {
    expect(stableJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
  });
});
