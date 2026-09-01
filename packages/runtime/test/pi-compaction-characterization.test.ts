import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  createAgentModelRuntime,
  createInMemoryAgentSettings,
  createNewAgentSessionRuntime,
  createPiSessionRuntimeFactory,
  registerAgentTestProvider,
} from "../src/pi-services";
import type { InlineExtension } from "../src/feature-api";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  type Context,
  type FauxProviderHandle,
} from "../src/testing";

/**
 * Characterization tests pinning Pi 0.84.4 compaction behavior. They exist so
 * a Pi upgrade that changes trigger, abort, hook, or context-event semantics
 * fails here first, before the Pho layers on top silently drift.
 */

interface CharacterizationHarness {
  session: AgentSession;
  faux: FauxProviderHandle;
  events: AgentSessionEvent[];
  /** Message arrays the provider actually received, in request order. */
  requests: Context["messages"][];
  dispose: () => Promise<void>;
}

async function createCharacterizationSession(options: {
  contextWindow?: number;
  compactionSettings?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number };
  extensionFactories?: InlineExtension[];
  respond?: (context: Context) => ReturnType<typeof fauxAssistantMessage>;
} = {}): Promise<CharacterizationHarness> {
  const root = await mkdtemp(path.join(tmpdir(), "pho-char-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "workspace");
  await mkdir(agentDir);
  await mkdir(cwd);

  const modelRuntime = await createAgentModelRuntime(agentDir);
  const faux = fauxProvider({
    provider: "char-test",
    api: "char-test-api",
    models: [
      {
        id: "small",
        name: "Characterization model",
        reasoning: false,
        input: ["text"],
        contextWindow: options.contextWindow ?? 32_000,
        maxTokens: 512,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    tokensPerSecond: 1_000,
  });
  const requests: Context["messages"][] = [];
  const factory = (context: Context) => {
    // The context is not structured-cloneable (it carries live references), so
    // keep a shallow snapshot of the message array only.
    requests.push([...context.messages]);
    faux.appendResponses([factory]);
    return options.respond?.(context) ?? fauxAssistantMessage(fauxText("characterization reply"));
  };
  faux.setResponses([factory]);
  registerAgentTestProvider(modelRuntime, faux);

  const sessionFactory = createPiSessionRuntimeFactory({
    modelRuntime,
    resourceLoaderOptions: () => ({
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      additionalExtensionPaths: [],
      additionalSkillPaths: [],
      additionalPromptTemplatePaths: [],
      extensionFactories: options.extensionFactories ?? [],
      systemPromptOverride: () => "You are a characterization test assistant.",
    }),
    settingsManager: () =>
      createInMemoryAgentSettings({
        compaction: options.compactionSettings ?? { enabled: false, keepRecentTokens: 64 },
        retry: { enabled: false },
      }),
    sessionOptions: () => ({ model: faux.getModel(), thinkingLevel: "off" }),
  });
  const runtime = await createNewAgentSessionRuntime(sessionFactory, { cwd, agentDir });
  const session = runtime.session;
  const events: AgentSessionEvent[] = [];
  session.subscribe((event) => {
    events.push(event);
  });
  return {
    session,
    faux,
    events,
    requests,
    dispose: async () => {
      await runtime.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function promptAndIdle(session: AgentSession, text: string): Promise<void> {
  await session.prompt(text);
  await session.waitForIdle();
}

/** Padded prompt so small keepRecentTokens budgets still leave compactable history. */
function paddedPrompt(label: string): string {
  return `${label} ${"padding ".repeat(50)}`;
}

function compactionEvents(events: AgentSessionEvent[]) {
  return events.filter((event) => event.type === "compaction_start" || event.type === "compaction_end");
}

describe("Pi 0.84.4 compaction characterization", () => {
  test("manual compact appends one compaction entry and rebuilds context from summary plus kept entries", async () => {
    const harness = await createCharacterizationSession();
    try {
      for (let index = 0; index < 6; index += 1) {
        await promptAndIdle(harness.session, paddedPrompt(`message ${index}`));
      }
      const branchBefore = harness.session.sessionManager.getBranch();
      expect(branchBefore.some((entry) => entry.type === "compaction")).toBe(false);

      const result = await harness.session.compact();
      expect(result.summary).toContain("characterization reply");
      expect(result.tokensBefore).toBeGreaterThan(0);

      const branch = harness.session.sessionManager.getBranch();
      const entries = branch.filter((entry) => entry.type === "compaction");
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;
      expect(entry.type === "compaction" && entry.fromHook).toBe(false);
      expect(entry.type === "compaction" && entry.summary).toBe(result.summary);
      // The full history stays in the branch; only the model context shrinks.
      expect(branch.length).toBe(branchBefore.length + 1);

      const context = harness.session.sessionManager.buildSessionContext();
      // Pinned 0.84.4 shape: the summary leads the session context with the
      // dedicated compactionSummary role…
      const lead = context.messages[0] as { role?: string; summary?: string } | undefined;
      expect(lead?.role).toBe("compactionSummary");
      expect(lead?.summary).toBe(result.summary);
      // Kept recent entries follow the summary.
      expect(context.messages.length).toBeGreaterThan(1);
      expect(context.messages.length).toBeLessThan(branch.length);

      const transitions = compactionEvents(harness.events);
      expect(transitions.map((event) => event.type)).toEqual(["compaction_start", "compaction_end"]);
      expect(transitions[0]).toMatchObject({ reason: "manual" });
      expect(transitions[1]).toMatchObject({ reason: "manual", aborted: false, willRetry: false });

      // …and the next provider request converts it to a wrapped user message.
      const requestsBefore = harness.requests.length;
      await promptAndIdle(harness.session, "after compaction");
      expect(harness.requests.length).toBeGreaterThan(requestsBefore);
      const nextRequest = harness.requests[requestsBefore]!;
      const leadRequest = nextRequest[0] as { role?: string; content?: unknown };
      expect(leadRequest.role).toBe("user");
      expect(JSON.stringify(leadRequest.content)).toContain(result.summary.slice(0, 40));
    } finally {
      await harness.dispose();
    }
  }, 30_000);

  test("threshold trigger auto-compacts after a response that crosses the budget", async () => {
    // Budget = contextWindow - reserveTokens = 2_000 tokens. The faux provider
    // reports usage from prompt size, so the second padded exchange crosses it
    // while staying far below the silent-overflow line.
    const harness = await createCharacterizationSession({
      contextWindow: 32_000,
      compactionSettings: { enabled: true, reserveTokens: 30_000, keepRecentTokens: 64 },
    });
    try {
      for (let index = 0; index < 5; index += 1) {
        await promptAndIdle(harness.session, paddedPrompt(`threshold probe ${index}`));
        if (compactionEvents(harness.events).length > 0) {
          break;
        }
      }

      const transitions = compactionEvents(harness.events);
      expect(transitions.length).toBeGreaterThanOrEqual(2);
      expect(transitions[0]).toMatchObject({ type: "compaction_start", reason: "threshold" });
      const end = transitions.find((event) => event.type === "compaction_end");
      expect(end).toMatchObject({ reason: "threshold", aborted: false, willRetry: false });

      const branch = harness.session.sessionManager.getBranch();
      expect(branch.some((entry) => entry.type === "compaction")).toBe(true);
      // The session stays usable afterwards.
      await promptAndIdle(harness.session, "after compaction");
      expect(harness.session.messages.at(-1)?.role).toBe("assistant");
    } finally {
      await harness.dispose();
    }
  }, 30_000);

  test("overflow trigger compacts and retries the turn once", async () => {
    let requestCount = 0;
    let overflowRequestIndex = -1;
    const harness = await createCharacterizationSession({
      compactionSettings: { enabled: true, reserveTokens: 100, keepRecentTokens: 64 },
      respond: () => {
        requestCount += 1;
        // Build history with normal replies, then fail one request with a
        // context-overflow error pattern Pi recognizes.
        if (requestCount === 4) {
          overflowRequestIndex = requestCount;
          return fauxAssistantMessage("overflow", {
            stopReason: "error",
            errorMessage: "prompt is too long",
          });
        }
        return fauxAssistantMessage(fauxText("recovered reply"));
      },
    });
    try {
      for (let index = 0; index < 3; index += 1) {
        await promptAndIdle(harness.session, paddedPrompt(`history ${index}`));
      }
      await promptAndIdle(harness.session, "trigger overflow");
      expect(overflowRequestIndex).toBe(4);

      const transitions = compactionEvents(harness.events);
      const start = transitions.find((event) => event.type === "compaction_start");
      expect(start).toMatchObject({ reason: "overflow" });
      const end = transitions.find((event) => event.type === "compaction_end");
      expect(end).toMatchObject({ reason: "overflow", aborted: false });
      // Case 1: the failed message is dropped from the retry context, the
      // compaction lands, and the turn is retried once.
      expect((end as { willRetry?: boolean } | undefined)?.willRetry).toBe(true);

      const branch = harness.session.sessionManager.getBranch();
      expect(branch.some((entry) => entry.type === "compaction")).toBe(true);
      // The failed assistant message stays in the persisted branch…
      const failedInBranch = branch.filter(
        (entry) =>
          entry.type === "message" &&
          (entry.message as { stopReason?: string }).stopReason === "error",
      );
      expect(failedInBranch.length).toBeGreaterThan(0);
      // …but is removed from the live agent state before the retry.
      const failedLive = harness.session.messages.filter(
        (message) => message.role === "assistant" && message.stopReason === "error",
      );
      expect(failedLive).toHaveLength(0);
      // …and the retried turn completes with the recovered reply.
      const last = harness.session.messages.at(-1);
      expect(last?.role).toBe("assistant");
      expect(JSON.stringify(last)).toContain("recovered reply");
    } finally {
      await harness.dispose();
    }
  }, 30_000);

  test("aborting a gated manual compaction appends no entry and leaves the session usable", async () => {
    let releaseGate: () => void = () => undefined;
    let markGateEntered: () => void = () => undefined;
    const gateEntered = new Promise<void>((resolve) => {
      markGateEntered = resolve;
    });
    const gate: InlineExtension = {
      name: "char-compaction-gate",
      factory(pi) {
        pi.on("session_before_compact", async (event) => {
          markGateEntered();
          await new Promise<void>((release) => {
            releaseGate = release;
            if (event.signal.aborted) {
              release();
              return;
            }
            event.signal.addEventListener("abort", () => release(), { once: true });
          });
          return undefined;
        });
      },
    };
    const harness = await createCharacterizationSession({ extensionFactories: [gate] });
    try {
      for (let index = 0; index < 6; index += 1) {
        await promptAndIdle(harness.session, paddedPrompt(`message ${index}`));
      }

      const pending = harness.session.compact();
      // Pi 0.84.4 surfaces the abort inside compact() as a rejection.
      const observed = pending.then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "rejected" as const, message: error instanceof Error ? error.message : String(error) }),
      );
      await gateEntered;
      harness.session.abortCompaction();
      releaseGate();
      const outcome = await observed;

      expect(outcome.kind).toBe("rejected");
      // Pinned 0.84.4 quirk: an abort that lands while the hook or the
      // summarization request is in flight is reported as a failure, not as
      // aborted: true. The compaction controller maps this back to cancelled.
      const end = compactionEvents(harness.events).find((event) => event.type === "compaction_end");
      expect(end).toBeDefined();
      expect((end as { aborted?: boolean }).aborted).toBe(false);
      expect((end as { errorMessage?: string }).errorMessage).toMatch(/abort/i);

      const branch = harness.session.sessionManager.getBranch();
      expect(branch.some((entry) => entry.type === "compaction")).toBe(false);

      // The session file stays valid and the next prompt succeeds.
      await promptAndIdle(harness.session, "still alive");
      expect(harness.session.messages.at(-1)?.role).toBe("assistant");
    } finally {
      await harness.dispose();
    }
  }, 30_000);

  test("context event mutations are request-only and never persist to the session", async () => {
    const marker = "EPHEMERAL-CONTEXT-INJECTION";
    const injector: InlineExtension = {
      name: "char-context-injector",
      factory(pi) {
        pi.on("context", (event) => ({
          messages: [
            ...event.messages,
            { role: "user", content: [{ type: "text" as const, text: marker }], timestamp: Date.now() },
          ],
        }));
      },
    };
    const harness = await createCharacterizationSession({ extensionFactories: [injector] });
    try {
      await promptAndIdle(harness.session, "hello");

      // The provider saw the injected line…
      expect(harness.requests.length).toBeGreaterThan(0);
      expect(JSON.stringify(harness.requests[0])).toContain(marker);
      // …but neither the branch nor the in-memory messages persist it.
      const branch = harness.session.sessionManager.getBranch();
      expect(JSON.stringify(branch)).not.toContain(marker);
      expect(JSON.stringify(harness.session.messages)).not.toContain(marker);
    } finally {
      await harness.dispose();
    }
  }, 30_000);

  test("a session_before_compact hook result replaces the summarizer; declining runs the default", async () => {
    const hookSummary = "HOOK PROVIDED DIGEST";
    const hook: InlineExtension = {
      name: "char-compaction-hook",
      factory(pi) {
        pi.on("session_before_compact", (event) => {
          if (event.customInstructions === "decline") {
            return undefined;
          }
          return {
            compaction: {
              summary: hookSummary,
              firstKeptEntryId: event.preparation.firstKeptEntryId,
              tokensBefore: event.preparation.tokensBefore,
              details: { kind: "pho-cutover" },
            },
          };
        });
      },
    };
    const harness = await createCharacterizationSession({ extensionFactories: [hook] });
    try {
      for (let index = 0; index < 6; index += 1) {
        await promptAndIdle(harness.session, paddedPrompt(`message ${index}`));
      }
      const requestsBeforeHook = harness.requests.length;

      const hooked = await harness.session.compact();
      expect(hooked.summary).toBe(hookSummary);
      // The digest path made no summarization request.
      expect(harness.requests.length).toBe(requestsBeforeHook);
      const hookedEntry = harness.session.sessionManager
        .getBranch()
        .find((entry) => entry.type === "compaction");
      expect(hookedEntry).toBeDefined();
      expect(hookedEntry!.type === "compaction" && hookedEntry!.fromHook).toBe(true);
      expect(
        hookedEntry!.type === "compaction" &&
          (hookedEntry!.details as { kind?: string } | undefined)?.kind,
      ).toBe("pho-cutover");

      // A declined hook falls back to the default summarizer, which does call
      // the provider. (The session needs fresh content past the cut point, so
      // add more messages first.)
      for (let index = 0; index < 6; index += 1) {
        await promptAndIdle(harness.session, paddedPrompt(`follow-up ${index}`));
      }
      const requestsBeforeDecline = harness.requests.length;
      const declined = await harness.session.compact("decline");
      expect(declined.summary).not.toBe(hookSummary);
      expect(harness.requests.length).toBeGreaterThan(requestsBeforeDecline);
      const branch = harness.session.sessionManager.getBranch();
      const entries = branch.filter((entry) => entry.type === "compaction");
      expect(entries).toHaveLength(2);
      const second = entries[1]!;
      expect(second.type === "compaction" && second.fromHook).toBe(false);
    } finally {
      await harness.dispose();
    }
  }, 30_000);
});
