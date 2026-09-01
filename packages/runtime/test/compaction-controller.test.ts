import { describe, expect, test } from "bun:test";
import type { AgentSession, AgentSessionEvent, CompactionResult } from "@earendil-works/pi-coding-agent";
import { HARNESS_ERROR_CODES, isHarnessError } from "@pho-agent/protocol";
import { createCompactionController } from "../src/compaction-controller";

interface FakeSession {
  isIdle: boolean;
  model: unknown;
  compactCalls: number;
  abortCompactionCalls: number;
  compact(): Promise<CompactionResult>;
  abortCompaction(): void;
}

function fakeSession(overrides: Partial<FakeSession> = {}): FakeSession {
  return {
    isIdle: true,
    model: { provider: "test", id: "model" },
    compactCalls: 0,
    abortCompactionCalls: 0,
    async compact() {
      this.compactCalls += 1;
      return { summary: "s", firstKeptEntryId: "e1", tokensBefore: 100, estimatedTokensAfter: 10 };
    },
    abortCompaction() {
      this.abortCompactionCalls += 1;
    },
    ...overrides,
  };
}

function startEvent(reason: "manual" | "threshold" | "overflow"): AgentSessionEvent {
  return { type: "compaction_start", reason } as AgentSessionEvent;
}

function endEvent(overrides: Record<string, unknown> = {}): AgentSessionEvent {
  return {
    type: "compaction_end",
    reason: "manual",
    result: { summary: "s", firstKeptEntryId: "e1", tokensBefore: 100, estimatedTokensAfter: 10 },
    aborted: false,
    willRetry: false,
    ...overrides,
  } as AgentSessionEvent;
}

describe("compaction controller", () => {
  test("starts idle and ignores non-compaction events", () => {
    const controller = createCompactionController();
    expect(controller.state()).toEqual({ status: "idle", cancelable: false });
    expect(controller.busy()).toBe(false);
    expect(controller.handleSessionEvent({ type: "agent_start" } as AgentSessionEvent)).toBeUndefined();
  });

  test("projects start and end into state changes with a completion notice", () => {
    const controller = createCompactionController();
    const started = controller.handleSessionEvent(startEvent("threshold"));
    expect(started?.state).toMatchObject({ status: "compacting", reason: "threshold", cancelable: false });
    expect(controller.busy()).toBe(true);

    const ended = controller.handleSessionEvent(endEvent({ reason: "threshold" }));
    expect(ended?.state).toEqual({ status: "idle", cancelable: false });
    expect(ended?.notice).toMatchObject({ outcome: "completed", reason: "threshold", tokensBefore: 100 });
    expect(controller.busy()).toBe(false);
  });

  test("tolerates an unpaired compaction_end after restart", () => {
    const controller = createCompactionController();
    const ended = controller.handleSessionEvent(
      endEvent({ result: undefined, aborted: false, errorMessage: "Context overflow recovery failed" }),
    );
    expect(ended?.state).toEqual({ status: "idle", cancelable: false });
    expect(ended?.notice?.outcome).toBe("failed");
    expect(ended?.notice?.errorMessage).toBe("Context overflow recovery failed");
  });

  test("manual compaction runs the guard and resolves completed", async () => {
    const controller = createCompactionController();
    const session = fakeSession();
    const result = await controller.startManual(session as unknown as AgentSession, "compactSession");
    expect(result).toEqual({ status: "completed", tokensBefore: 100, estimatedTokensAfter: 10 });
    expect(session.compactCalls).toBe(1);
  });

  test("manual compaction refuses while a run is active", async () => {
    const controller = createCompactionController();
    const session = fakeSession({ isIdle: false });
    const attempt = controller.startManual(session as unknown as AgentSession, "compactSession");
    await expect(attempt).rejects.toMatchObject({ code: HARNESS_ERROR_CODES.sessionBusy });
    expect(session.compactCalls).toBe(0);
  });

  test("manual compaction refuses without a model", async () => {
    const controller = createCompactionController();
    const session = fakeSession({ model: undefined });
    const attempt = controller.startManual(session as unknown as AgentSession, "compactSession");
    await expect(attempt).rejects.toMatchObject({ code: HARNESS_ERROR_CODES.noAuthenticatedModel });
  });

  test("a second manual compaction is rejected while one is in flight", async () => {
    const controller = createCompactionController();
    let release: (value: CompactionResult) => void = () => undefined;
    const session = fakeSession({
      compact() {
        this.compactCalls += 1;
        return new Promise<CompactionResult>((resolve) => {
          release = resolve;
        });
      },
    });
    const first = controller.startManual(session as unknown as AgentSession, "compactSession");
    await Promise.resolve();
    const second = controller.startManual(session as unknown as AgentSession, "compactSession");
    await expect(second).rejects.toMatchObject({ code: HARNESS_ERROR_CODES.sessionBusy });
    release({ summary: "s", firstKeptEntryId: "e1", tokensBefore: 5 });
    await first;
  });

  test("cancel aborts the in-flight manual compaction and reports cancelled", async () => {
    const controller = createCompactionController();
    const session = fakeSession({
      compact() {
        this.compactCalls += 1;
        return new Promise<CompactionResult>((_resolve, reject) => {
          setTimeout(() => {
            const error = new Error("Compaction cancelled");
            reject(error);
          }, 5);
        });
      },
    });
    const pending = controller.startManual(session as unknown as AgentSession, "compactSession");
    await Promise.resolve();
    expect(controller.manualInFlight()).toBe(true);
    controller.cancel(session as unknown as AgentSession);
    expect(session.abortCompactionCalls).toBe(1);
    const result = await pending;
    expect(result).toEqual({ status: "cancelled" });
  });

  test("failed compaction surfaces a sanitized message", async () => {
    const controller = createCompactionController();
    const session = fakeSession({
      compact() {
        this.compactCalls += 1;
        throw new Error("provider exploded\nwith details");
      },
    });
    const result = await controller.startManual(session as unknown as AgentSession, "compactSession");
    expect(result).toEqual({ status: "failed", message: "provider exploded with details" });
  });

  test("a host cancel projects cancelled even when Pi reports the abort as a failure", async () => {
    // Pi 0.84.4 emits compaction_end with aborted=false and
    // "Summarization failed: The operation was aborted." when the abort lands
    // while the summarization request is in flight.
    const controller = createCompactionController();
    const session = fakeSession({
      compact() {
        this.compactCalls += 1;
        return new Promise<CompactionResult>((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error("Summarization failed: The operation was aborted."));
          }, 5);
        });
      },
    });
    const pending = controller.startManual(session as unknown as AgentSession, "compactSession");
    await Promise.resolve();
    controller.handleSessionEvent(startEvent("manual"));
    controller.cancel(session as unknown as AgentSession);
    const ended = controller.handleSessionEvent(
      endEvent({
        result: undefined,
        aborted: false,
        errorMessage: "Compaction failed: Summarization failed: The operation was aborted.",
      }),
    );
    expect(ended?.notice?.outcome).toBe("cancelled");
    expect(ended?.notice?.errorMessage).toBeUndefined();
    await expect(pending).resolves.toEqual({ status: "cancelled" });
  });

  test("live completion enriches the newest boundary only", () => {
    const controller = createCompactionController({ now: () => Date.parse("2026-09-01T02:00:00.000Z") });
    controller.handleSessionEvent(startEvent("manual"));
    controller.handleSessionEvent(endEvent());
    const older = controller.enrichBoundary("old-entry", "2026-09-01T00:30:00.000Z");
    expect(older).toBeUndefined();
    const newest = controller.enrichBoundary("new-entry", "2026-09-01T02:00:01.000Z");
    expect(newest).toMatchObject({ reason: "manual", tokensBefore: 100, estimatedTokensAfter: 10 });
    // Cached by entry id afterwards.
    expect(controller.enrichBoundary("new-entry", "2026-09-01T02:00:01.000Z")).toBe(newest);
  });

  test("reset clears transient state but keeps entry enrichments", () => {
    const controller = createCompactionController({ now: () => Date.parse("2026-09-01T02:00:00.000Z") });
    controller.handleSessionEvent(startEvent("manual"));
    controller.handleSessionEvent(endEvent());
    controller.enrichBoundary("entry-1", "2026-09-01T02:00:01.000Z");
    controller.reset();
    expect(controller.state()).toEqual({ status: "idle", cancelable: false });
    expect(controller.enrichBoundary("entry-1", "2026-09-01T02:00:01.000Z")).toMatchObject({ reason: "manual" });
  });

  test("harness errors from the guard are recoverable", async () => {
    const controller = createCompactionController();
    const session = fakeSession({ isIdle: false });
    const failure = await controller
      .startManual(session as unknown as AgentSession, "compactSession")
      .then(() => undefined, (error: unknown) => error);
    expect(isHarnessError(failure)).toBe(true);
    expect((failure as { recoverable: boolean }).recoverable).toBe(true);
  });
});
