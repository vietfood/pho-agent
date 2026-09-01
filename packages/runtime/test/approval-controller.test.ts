import { describe, expect, test } from "bun:test";
import {
  ApprovalController,
  canonicalizeApprovalInput,
  fingerprintApprovalInput,
  freezeApprovalInput,
  type ApprovalActionRequest,
  type ApprovalPolicy,
  type ApprovalPolicyEvaluation,
} from "../src/approval-controller";

const key = { scopeId: "/tmp/workspace", sessionId: "session-1" };
const reviewPolicy: ApprovalPolicy = () => ({
  boundary: { outcome: "review", ruleId: "boundary.review" },
});

function action(
  requestId: string,
  input: unknown = { command: "bun test" },
  overrides: Partial<ApprovalActionRequest> = {},
): ApprovalActionRequest {
  return {
    ...key,
    runId: "run-1",
    requestId,
    toolName: "bash",
    input,
    ...overrides,
  };
}

describe("approval input", () => {
  test("canonicalizes plain JSON and fingerprints equivalent key order", () => {
    const left = { z: [2, { b: true, a: null }], a: "value" };
    const right = { a: "value", z: [2, { a: null, b: true }] };

    expect(canonicalizeApprovalInput(left)).toBe(
      '{"a":"value","z":[2,{"a":null,"b":true}]}',
    );
    expect(fingerprintApprovalInput(left)).toBe(fingerprintApprovalInput(right));
    const frozen = freezeApprovalInput(left);
    left.z[1] = { changed: true };
    expect(frozen.value).toEqual(right);
  });

  test("rejects unsafe and oversized inputs", () => {
    expect(() => freezeApprovalInput({ value: undefined })).toThrow("JSON-safe");
    expect(() => freezeApprovalInput(Object.create(null))).toThrow("JSON-safe");
    expect(() => freezeApprovalInput({ text: "x".repeat(128 * 1024) })).toThrow("exceeds");
  });
});

describe("ApprovalController", () => {
  test("creates exact owner once/session grants and revokes them", async () => {
    let ownerCalls = 0;
    const controller = new ApprovalController({
      key,
      policy: reviewPolicy,
      ownerResolver: () => {
        ownerCalls += 1;
        return { outcome: "allow-session" };
      },
    });
    controller.beginRun("run-1");

    const first = await controller.authorize(action("request-1", { path: "/tmp/a" }, { grantKey: "write:/tmp" }));
    expect(first).toMatchObject({ authorized: true, source: "owner", grantScope: "session" });
    if (!first.authorized) throw new Error("expected authorization");
    expect(controller.consumeAuthorization({
      authorizationId: first.authorizationId,
      runId: "run-1",
      input: { path: "/tmp/a" },
    }).fingerprint).toBe(first.fingerprint);
    expect(controller.snapshot().activeGrantCount).toBe(1);

    const second = await controller.authorize(action("request-2", { path: "/tmp/b" }, { grantKey: "write:/tmp" }));
    expect(second).toMatchObject({ authorized: true, source: "session-grant", grantScope: "once" });
    expect(ownerCalls).toBe(1);
    expect(controller.revokeSessionGrant("write:/tmp")).toBe(true);
    expect(controller.snapshot().activeGrantCount).toBe(0);
  });

  test("locks dispatch to the admitted run, generation, and exact input", async () => {
    const controller = new ApprovalController({
      key,
      policy: () => ({ boundary: { outcome: "allow", ruleId: "routine" } }),
    });
    controller.beginRun("run-1");
    const stale = await controller.authorize(action("stale", {}, { runId: "other" }));
    expect(stale).toMatchObject({
      authorized: false,
      outcome: "stale",
    });

    const result = await controller.authorize(action("exact", { command: "bun test" }));
    if (!result.authorized) throw new Error("expected authorization");
    expect(() =>
      controller.consumeAuthorization({
        authorizationId: result.authorizationId,
        runId: "run-1",
        input: { command: "bun test --watch" },
      }),
    ).toThrow("changed");
    expect(() =>
      controller.consumeAuthorization({
        authorizationId: result.authorizationId,
        runId: "run-1",
        input: { command: "bun test" },
      }),
    ).toThrow("already consumed");
    expect(() => controller.setMode("full")).toThrow("idle");

    controller.endRun("run-1");
    controller.setMode("full");
    expect(controller.snapshot()).toMatchObject({ mode: "full", policyGeneration: 1 });
  });

  test("revalidates mutable policy immediately before dispatch", async () => {
    let changed = false;
    const controller = new ApprovalController({
      key,
      policy: () => ({
        boundary: changed
          ? { outcome: "deny", ruleId: "boundary.changed" }
          : { outcome: "review", ruleId: "boundary.review" },
      }),
      ownerResolver: () => {
        changed = true;
        return { outcome: "allow-once" };
      },
    });
    controller.beginRun("run-1");

    expect(await controller.authorize(action("policy-changed"))).toMatchObject({
      authorized: false,
      outcome: "stale",
      rationale: "Approval policy changed before tool dispatch.",
    });
  });

  test("keeps invariant and explicit project denies ahead of Full", async () => {
    let kind: "invariant" | "project" | "routine" = "invariant";
    let ownerCalls = 0;
    const controller = new ApprovalController({
      key,
      mode: "full",
      policy: () => ({
        ...(kind === "invariant"
          ? { invariantDeny: { outcome: "deny" as const, ruleId: "invariant.delete" } }
          : {}),
        ...(kind === "project"
          ? { project: { outcome: "deny" as const, ruleId: "project.deny" } }
          : {}),
        boundary: { outcome: "review", ruleId: "boundary.review" },
      }),
      ownerResolver: () => {
        ownerCalls += 1;
        return { outcome: "allow-once" };
      },
    });
    controller.beginRun("run-1");

    expect(await controller.authorize(action("invariant"))).toMatchObject({ authorized: false, outcome: "deny" });
    kind = "project";
    expect(await controller.authorize(action("project"))).toMatchObject({ authorized: false, outcome: "deny" });
    kind = "routine";
    expect(await controller.authorize(action("routine"))).toMatchObject({ authorized: true, source: "policy" });
    expect(ownerCalls).toBe(0);
  });

  test("cancels an isolated reviewer and rejects late results", async () => {
    let settle!: (value: unknown) => void;
    const reviewer = new Promise<unknown>((resolve) => {
      settle = resolve;
    });
    const controller = new ApprovalController({
      key,
      mode: "auto",
      policy: reviewPolicy,
      autoReviewer: () => reviewer,
    });
    controller.beginRun("run-1");
    const abort = new AbortController();
    const pending = controller.authorize(action("cancel"), { signal: abort.signal });
    abort.abort();
    expect(await pending).toMatchObject({ authorized: false, outcome: "cancelled" });
    settle({ outcome: "allow-once" });
    await Promise.resolve();
    expect(controller.snapshot().reviewerState).toBe("idle");
  });

  test("bounds automatic review to one active request", async () => {
    let settle!: (value: unknown) => void;
    let calls = 0;
    const controller = new ApprovalController({
      key,
      mode: "auto",
      policy: reviewPolicy,
      autoReviewer: () => {
        calls += 1;
        return new Promise((resolve) => {
          settle = resolve;
        });
      },
    });
    controller.beginRun("run-1");

    const first = controller.authorize(action("reviewing"));
    await Promise.resolve();
    expect(await controller.authorize(action("concurrent"))).toMatchObject({
      authorized: false,
      outcome: "require-owner",
    });
    expect(calls).toBe(1);
    settle({ outcome: "deny" });
    expect(await first).toMatchObject({ authorized: false, outcome: "deny" });
  });

  test("fails closed on a malformed automatic decision", async () => {
    const controller = new ApprovalController({
      key,
      mode: "auto",
      policy: reviewPolicy,
      autoReviewer: () => ({ outcome: "allow-once", extra: "not allowed" }),
    });
    controller.beginRun("run-1");
    expect(await controller.authorize(action("malformed"))).toMatchObject({
      authorized: false,
      outcome: "unavailable",
    });
  });

  test("opens the automatic-review circuit after three consecutive denials", async () => {
    let calls = 0;
    const outcomes: string[] = [];
    const controller = new ApprovalController({
      key,
      mode: "auto",
      policy: reviewPolicy,
      autoReviewer: () => {
        calls += 1;
        return { outcome: "deny", rationale: "unsafe" };
      },
      onDecision: (record) => outcomes.push(record.outcome),
    });
    controller.beginRun("run-1");

    for (let index = 0; index < 2; index += 1) {
      expect(await controller.authorize(action(`denial-${index}`))).toMatchObject({
        authorized: false,
        outcome: "deny",
      });
    }
    expect(await controller.authorize(action("denial-2"))).toMatchObject({
      authorized: false,
      outcome: "circuit-open",
      rationale: expect.stringContaining("repeated denials"),
    });
    expect(controller.snapshot().circuitOpen).toBe(true);
    expect(await controller.authorize(action("blocked-by-circuit"))).toMatchObject({
      authorized: false,
      outcome: "circuit-open",
    });
    expect(calls).toBe(3);
    expect(outcomes).toEqual(["deny", "deny", "circuit-open", "circuit-open"]);
  });

  test("cancels other pending authorizations when the circuit opens", async () => {
    let releasePolicy!: (value: ApprovalPolicyEvaluation) => void;
    let reviewerCalls = 0;
    const controller = new ApprovalController({
      key,
      mode: "auto",
      policy: (request) =>
        request.requestId === "late"
          ? new Promise<ApprovalPolicyEvaluation>((resolve) => {
              releasePolicy = resolve;
            })
          : reviewPolicy(request),
      autoReviewer: () => {
        reviewerCalls += 1;
        return { outcome: "deny" };
      },
    });
    controller.beginRun("run-1");
    const late = controller.authorize(action("late"));

    for (let index = 0; index < 3; index += 1) {
      await controller.authorize(action(`circuit-${index}`));
    }
    expect(await late).toMatchObject({ authorized: false, outcome: "cancelled" });
    releasePolicy({ boundary: { outcome: "review", ruleId: "boundary.review" } });
    await Promise.resolve();
    expect(reviewerCalls).toBe(3);
  });

  test("opens the rolling circuit at ten denials in fifty decisions", async () => {
    let decisionIndex = 0;
    const controller = new ApprovalController({
      key,
      mode: "auto",
      policy: reviewPolicy,
      autoReviewer: () => ({ outcome: decisionIndex++ % 2 === 0 ? "deny" : "allow-once" }),
    });
    controller.beginRun("run-1");
    let last;
    for (let index = 0; index < 19; index += 1) {
      last = await controller.authorize(action(`rolling-${index}`));
    }
    expect(last).toMatchObject({ authorized: false, outcome: "circuit-open" });
    expect(controller.snapshot().circuitOpen).toBe(true);
    expect(await controller.authorize(action("rolling-block"))).toMatchObject({
      authorized: false,
      outcome: "circuit-open",
    });
  });

  test("uses one exact owner retry marker for re-review without bypassing policy", async () => {
    let invariant = false;
    const retries: boolean[] = [];
    const controller = new ApprovalController({
      key,
      mode: "auto",
      policy: () => ({
        ...(invariant
          ? { invariantDeny: { outcome: "deny" as const, ruleId: "invariant" } }
          : {}),
        boundary: { outcome: "review", ruleId: "review" },
      }),
      autoReviewer: (request) => {
        retries.push(request.ownerRetry);
        return { outcome: retries.length === 1 ? "deny" : "allow-once" };
      },
    });
    controller.beginRun("run-1");
    const request = action("retry", { path: "/tmp/exact" });

    expect(await controller.authorize(request)).toMatchObject({ authorized: false, outcome: "deny" });
    expect(controller.authorizeRetry("retry")).toBe(true);
    const allowed = await controller.authorize(action("retry-next", { path: "/tmp/exact" }));
    expect(allowed).toMatchObject({ authorized: true, source: "reviewer" });
    expect(retries).toEqual([false, true]);
    expect(controller.authorizeRetry("retry")).toBe(false);
    expect(await controller.authorize(request)).toMatchObject({ authorized: false, outcome: "stale" });

    const deniedRequest = action("retry-invariant", { command: "safe" });
    const secondController = new ApprovalController({
      key,
      mode: "auto",
      policy: () => ({
        ...(invariant
          ? { invariantDeny: { outcome: "deny" as const, ruleId: "invariant" } }
          : {}),
        boundary: { outcome: "review", ruleId: "review" },
      }),
      autoReviewer: () => ({ outcome: "deny" }),
    });
    secondController.beginRun("run-1");
    invariant = false;
    expect(await secondController.authorize(deniedRequest)).toMatchObject({ authorized: false, outcome: "deny" });
    expect(secondController.authorizeRetry("retry-invariant")).toBe(true);
    invariant = true;
    expect(
      await secondController.authorize(action("retry-invariant-next", { command: "safe" })),
    ).toMatchObject({ authorized: false, outcome: "deny" });

    invariant = false;
    const mismatches: Array<{
      label: string;
      mutate: (request: ApprovalActionRequest) => ApprovalActionRequest;
      expected: object;
    }> = [
      {
        label: "input",
        mutate: (request) => ({ ...request, input: { command: "changed" } }),
        expected: { authorized: true },
      },
      {
        label: "tool",
        mutate: (request) => ({ ...request, toolName: "write" }),
        expected: { authorized: true },
      },
      {
        label: "run",
        mutate: (request) => ({ ...request, runId: "stale-run" }),
        expected: { authorized: false, outcome: "stale" },
      },
    ];
    for (const { label, mutate, expected } of mismatches) {
      const retryFlags: boolean[] = [];
      const exactController = new ApprovalController({
        key,
        mode: "auto",
        policy: reviewPolicy,
        autoReviewer: (review) => {
          retryFlags.push(review.ownerRetry);
          return { outcome: retryFlags.length === 1 ? "deny" : "allow-once" };
        },
      });
      exactController.beginRun("run-1");
      const prior = action(`prior-${label}`, { command: "safe" });
      expect(await exactController.authorize(prior)).toMatchObject({ authorized: false, outcome: "deny" });
      expect(exactController.authorizeRetry(prior.requestId)).toBe(true);
      expect(
        await exactController.authorize(mutate(action(`mismatch-${label}`, { command: "safe" }))),
      ).toMatchObject(expected);
      expect(
        await exactController.authorize(action(`after-${label}`, { command: "safe" })),
      ).toMatchObject({ authorized: true });
      expect(retryFlags).not.toContain(true);
    }
  });

  test("records redacted decisions and revokes lifecycle state on dispose", async () => {
    const records: unknown[] = [];
    const controller = new ApprovalController({
      key,
      policy: () => ({ boundary: { outcome: "allow", ruleId: "routine" } }),
      onDecision: (record) => records.push(record),
    });
    controller.beginRun("run-1");
    await controller.authorize(action("logged", { secret: "not-in-record" }));
    expect(JSON.stringify(records)).not.toContain("not-in-record");
    controller.dispose();
    expect(controller.snapshot()).toMatchObject({ reviewerState: "none", activeGrantCount: 0 });
    expect(() => controller.beginRun("run-2")).toThrow("disposed");
  });
});
