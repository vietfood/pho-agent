import { describe, expect, test } from "bun:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  createApprovalReviewerPool,
  createSessionApprovalReviewer,
  parseApprovalReviewerDecision,
} from "../src/approval-reviewer";
import type { ApprovalReviewRequest } from "../src/approval-controller";

describe("session approval reviewer", () => {
  test("bounds concurrent reviews and cancels queued work", async () => {
    const pool = createApprovalReviewerPool(1);
    let release!: () => void;
    const first = pool.run(
      () => new Promise<void>((resolve) => { release = resolve; }),
      new AbortController().signal,
    );
    await Promise.resolve();
    const abort = new AbortController();
    const second = pool.run(async () => undefined, abort.signal);
    expect(pool.snapshot()).toEqual({ active: 1, pending: 1, limit: 1 });
    abort.abort();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    release();
    await first;
    expect(pool.snapshot()).toEqual({ active: 0, pending: 0, limit: 1 });
  });

  test("parses only strict automatic-review decisions", () => {
    expect(parseApprovalReviewerDecision('{"version":1,"outcome":"allow-once","rationale":"contained exact action"}')).toEqual({
      outcome: "allow-once",
      rationale: "contained exact action",
    });
    expect(parseApprovalReviewerDecision('{"version":1,"outcome":"deny","rationale":"unsafe"}')).toEqual({
      outcome: "deny",
      rationale: "unsafe",
    });
    expect(() => parseApprovalReviewerDecision("```json\n{}\n```")).toThrow("one JSON");
    expect(() => parseApprovalReviewerDecision('{"version":1,"outcome":"allow-once"}')).toThrow("invalid");
    expect(() => parseApprovalReviewerDecision('{"version":1,"outcome":"allow-session","rationale":"no"}')).toThrow("invalid");
    expect(() => parseApprovalReviewerDecision('{"version":1,"outcome":"allow-once","rationale":"yes","extra":true}')).toThrow("invalid");
  });

  test("uses an explicitly selected reviewer model", async () => {
    const faux = fauxProvider({
      provider: "approval-reviewer-test",
      api: "approval-reviewer-test-api",
      models: [{ id: "chat" }, { id: "reviewer" }],
    });
    let observedModel: string | undefined;
    faux.setResponses([
      (_context, _options, _state, model) => {
        observedModel = model.id;
        return fauxAssistantMessage(fauxText('{"version":1,"outcome":"allow-once","rationale":"safe"}'));
      },
    ]);
    const sourceAgent = new Agent({
      initialState: {
        systemPrompt: "Chat session",
        model: faux.getModel("chat"),
        thinkingLevel: "off",
        tools: [],
        messages: [],
      },
      streamFn: faux.provider.streamSimple,
    });
    const source = { agent: sourceAgent } as AgentSession;
    const reviewer = createSessionApprovalReviewer(() => source, {
      systemPrompt: "Return one JSON decision.",
      buildPrompt: () => "Review this action.",
      modelFor: () => faux.getModel("reviewer"),
    });

    await expect(reviewer(reviewRequest(), new AbortController().signal)).resolves.toEqual({
      outcome: "allow-once",
      rationale: "safe",
    });
    expect(observedModel).toBe("reviewer");
  });

  test("honors cancellation before resolving a source session", async () => {
    let sourceCalls = 0;
    const reviewer = createSessionApprovalReviewer(
      () => {
        sourceCalls += 1;
        return undefined;
      },
      {
        systemPrompt: "Return one JSON decision.",
        buildPrompt: () => "Review this action.",
      },
    );
    const abort = new AbortController();
    abort.abort();

    await expect(reviewer({} as ApprovalReviewRequest, abort.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(sourceCalls).toBe(0);
  });
});

function reviewRequest(): ApprovalReviewRequest {
  return {
    action: {
      scopeId: "/tmp/workspace",
      sessionId: "session-1",
      runId: "run-1",
      requestId: "request-1",
      toolName: "bash",
      input: { command: "bun test" },
      inputCanonical: '{"command":"bun test"}',
      inputFingerprint: "fingerprint",
    },
    mode: "auto",
    policy: { outcome: "review", ruleId: "boundary.review" },
    ownerRetry: false,
  };
}
