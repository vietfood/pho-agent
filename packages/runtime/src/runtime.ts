import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  agentScopeKeyId,
  normalizeAgentScopeKey,
  requireAgentId,
  type AgentAbortInput,
  type AgentFollowUpInput,
  type AgentPromptAdmission,
  type AgentPromptInput,
  type AgentQueueAdmission,
  type AgentRuntimeEvent,
  type AgentScopeKey,
  type AgentSessionSnapshot,
  type AgentSteerInput,
  type AgentTranscriptBlock,
  type AgentTranscriptMessage,
  type Unsubscribe,
} from "@pho-agent/protocol";
import type { AgentSession, AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { FauxProviderHandle } from "@earendil-works/pi-ai";
import {
  createAgentModelRuntime,
  createInMemoryAgentSettings,
  createNewAgentSessionRuntime,
  createPiSessionRuntimeFactory,
  listAgentSessions,
  openAgentSessionRuntime,
  registerAgentTestProvider,
  type AgentManagedSession,
} from "./pi-services";
import { flattenAgentFeatures, type AgentFeature } from "./features";

export interface AgentScopeResolution {
  runtimeDirectory: string;
}

export interface AgentScopeAdapter {
  resolve(scopeId: string): Promise<AgentScopeResolution> | AgentScopeResolution;
}

export interface EvidenceProvider {
  id: string;
}

export interface VerificationAdapter {
  id: string;
}

export interface AgentProductAdapter {
  id: string;
  scope: AgentScopeAdapter;
  features: readonly AgentFeature[];
  evidenceProviders: readonly EvidenceProvider[];
  verificationAdapters: readonly VerificationAdapter[];
}

export interface AgentRuntime {
  getSessionSnapshot(key: AgentScopeKey): Promise<AgentSessionSnapshot>;
  createSession(scopeId: string): Promise<AgentSessionSnapshot>;
  openSession(key: AgentScopeKey): Promise<AgentSessionSnapshot>;
  sendPrompt(input: AgentPromptInput): Promise<AgentPromptAdmission>;
  steerRun(input: AgentSteerInput): Promise<AgentQueueAdmission>;
  queueFollowUp(input: AgentFollowUpInput): Promise<AgentQueueAdmission>;
  abortRun(input: AgentAbortInput): Promise<void>;
  subscribe(listener: (event: AgentRuntimeEvent) => void): Unsubscribe;
  dispose(): Promise<void>;
}

export interface CreateAgentRuntimeOptions {
  agentDir: string;
  product: AgentProductAdapter;
  testProvider?: FauxProviderHandle;
  testTools?: readonly ToolDefinition[];
  systemPrompt?: string;
}

interface LiveAgentSession {
  key: AgentScopeKey;
  runtime: AgentManagedSession;
  run?: { id: string; cancelled: boolean };
  unsubscribe: Unsubscribe;
}

export async function createAgentRuntime(options: CreateAgentRuntimeOptions): Promise<AgentRuntime> {
  const agentDir = path.resolve(options.agentDir);
  const modelRuntime = await createAgentModelRuntime(agentDir);
  if (options.testProvider) {
    registerAgentTestProvider(modelRuntime, options.testProvider);
  }
  const featureResources = flattenAgentFeatures(options.product.features);
  const factory = createPiSessionRuntimeFactory({
    modelRuntime,
    ...(options.testProvider
      ? {
          settingsManager: () =>
            createInMemoryAgentSettings({ compaction: { enabled: false }, retry: { enabled: false } }),
        }
      : {}),
    resourceLoaderOptions: () => ({
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      additionalExtensionPaths: featureResources.additionalExtensionPaths,
      additionalSkillPaths: featureResources.additionalSkillPaths,
      additionalPromptTemplatePaths: featureResources.additionalPromptTemplatePaths,
      extensionFactories: featureResources.extensionFactories,
      ...(options.systemPrompt ? { systemPromptOverride: () => options.systemPrompt } : {}),
    }),
    sessionOptions: () => ({
      ...(options.testProvider
        ? { model: options.testProvider.getModel(), thinkingLevel: "off" as const }
        : {}),
      ...(options.testTools && options.testTools.length > 0
        ? {
            customTools: [...options.testTools],
            tools: options.testTools.map((tool) => tool.name),
          }
        : {}),
    }),
  });
  const sessions = new Map<string, LiveAgentSession>();
  const listeners = new Set<(event: AgentRuntimeEvent) => void>();
  let disposed = false;

  function emit(event: AgentRuntimeEvent): void {
    for (const listener of listeners) {
      listener(event);
    }
  }

  function snapshot(live: LiveAgentSession): AgentSessionSnapshot {
    return {
      key: live.key,
      run: live.run
        ? { status: live.run.cancelled ? "cancelled" : "running", runId: live.run.id }
        : { status: "idle" },
      messages: projectMessages(live.runtime.session.messages),
    };
  }

  function publishSnapshot(live: LiveAgentSession): AgentSessionSnapshot {
    const value = snapshot(live);
    emit({ ...live.key, type: "session_snapshot", occurredAt: new Date().toISOString(), snapshot: value });
    return value;
  }

  async function resolveScope(scopeIdInput: string): Promise<{ scopeId: string; cwd: string }> {
    const scopeId = requireAgentId(scopeIdInput, "scopeId");
    const resolution = await options.product.scope.resolve(scopeId);
    if (!resolution || typeof resolution.runtimeDirectory !== "string") {
      throw new TypeError("The product scope adapter returned no runtime directory.");
    }
    return { scopeId, cwd: path.resolve(resolution.runtimeDirectory) };
  }

  async function bind(key: AgentScopeKey, runtime: AgentManagedSession): Promise<LiveAgentSession> {
    const normalized = normalizeAgentScopeKey(key);
    const live: LiveAgentSession = { key: normalized, runtime, unsubscribe: () => undefined };
    live.unsubscribe = runtime.session.subscribe((event) => handleSessionEvent(live, event));
    sessions.set(agentScopeKeyId(normalized), live);
    await runtime.session.bindExtensions({});
    return live;
  }

  async function open(keyInput: AgentScopeKey): Promise<LiveAgentSession> {
    const key = normalizeAgentScopeKey(keyInput);
    const existing = sessions.get(agentScopeKeyId(key));
    if (existing) {
      return existing;
    }
    const { cwd } = await resolveScope(key.scopeId);
    const runtime = await openAgentSessionRuntime(factory, { cwd, agentDir, sessionId: key.sessionId });
    if (!runtime) {
      throw new Error("The selected agent session was not found.");
    }
    return bind(key, runtime);
  }

  function handleSessionEvent(live: LiveAgentSession, event: AgentSessionEvent): void {
    if (event.type === "message_end" || event.type === "tool_execution_end") {
      publishSnapshot(live);
    }
  }

  function assertAvailable(): void {
    if (disposed) {
      throw new Error("The agent runtime is disposed.");
    }
  }

  async function queue(
    input: AgentSteerInput,
    operation: (session: AgentSession) => Promise<void>,
  ): Promise<AgentQueueAdmission> {
    assertAvailable();
    const live = await open(input);
    if (!live.run || live.run.id !== requireAgentId(input.runId, "runId")) {
      throw new Error("The target run is not active.");
    }
    const text = input.text.trim();
    if (!text) {
      throw new TypeError("A queue message is required.");
    }
    await operation(live.runtime.session);
    return { ...live.key, runId: live.run.id, admitted: true };
  }

  return {
    async getSessionSnapshot(key) {
      assertAvailable();
      return snapshot(await open(key));
    },
    async createSession(scopeIdInput) {
      assertAvailable();
      const { scopeId, cwd } = await resolveScope(scopeIdInput);
      const runtime = await createNewAgentSessionRuntime(factory, { cwd, agentDir });
      return publishSnapshot(await bind({ scopeId, sessionId: runtime.session.sessionId }, runtime));
    },
    async openSession(key) {
      assertAvailable();
      return publishSnapshot(await open(key));
    },
    async sendPrompt(input) {
      assertAvailable();
      const live = await open(input);
      if (live.run) {
        throw new Error("The agent session is already running.");
      }
      const text = input.text.trim();
      if (!text) {
        throw new TypeError("A prompt is required.");
      }
      const runId = randomUUID();
      live.run = { id: runId, cancelled: false };
      let resolvePreflight: (accepted: boolean) => void = () => undefined;
      const preflight = new Promise<boolean>((resolve) => {
        resolvePreflight = resolve;
      });
      const prompt = live.runtime.session.prompt(text, {
        source: "interactive",
        preflightResult: resolvePreflight,
      });
      const accepted = await preflight;
      if (!accepted) {
        live.run = undefined;
        await prompt.catch(() => undefined);
        throw new Error("The prompt was rejected before admission.");
      }
      emit({ ...live.key, type: "run_started", occurredAt: new Date().toISOString(), runId });
      void prompt.then(
        () => {
          if (live.run?.id !== runId) return;
          const cancelled = live.run.cancelled;
          live.run = undefined;
          emit({
            ...live.key,
            type: cancelled ? "run_cancelled" : "run_settled",
            occurredAt: new Date().toISOString(),
            runId,
          });
          publishSnapshot(live);
        },
        (error: unknown) => {
          if (live.run?.id !== runId) return;
          const cancelled = live.run.cancelled;
          live.run = undefined;
          emit({
            ...live.key,
            type: cancelled ? "run_cancelled" : "run_failed",
            occurredAt: new Date().toISOString(),
            runId,
            ...(cancelled ? {} : { error: error instanceof Error ? error.message : "The agent run failed." }),
          } as AgentRuntimeEvent);
          publishSnapshot(live);
        },
      );
      return { ...live.key, runId, admitted: true };
    },
    steerRun(input) {
      return queue(input, (session) => session.steer(input.text));
    },
    queueFollowUp(input) {
      return queue(input, (session) => session.followUp(input.text));
    },
    async abortRun(input) {
      assertAvailable();
      const live = await open(input);
      if (!live.run || live.run.id !== requireAgentId(input.runId, "runId")) {
        return;
      }
      live.run.cancelled = true;
      live.runtime.session.clearQueue();
      await live.runtime.session.abort();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await Promise.all(
        [...sessions.values()].map(async (live) => {
          live.unsubscribe();
          if (live.run) {
            live.run.cancelled = true;
            await live.runtime.session.abort().catch(() => undefined);
          }
          await live.runtime.dispose();
        }),
      );
      sessions.clear();
      listeners.clear();
    },
  };
}

export async function listProductAgentSessions(
  product: AgentProductAdapter,
  agentDir: string,
  scopeIdInput: string,
): Promise<string[]> {
  const scopeId = requireAgentId(scopeIdInput, "scopeId");
  const resolution = await product.scope.resolve(scopeId);
  return (await listAgentSessions(path.resolve(resolution.runtimeDirectory), agentDir)).map((session) => session.id);
}

function projectMessages(messages: readonly unknown[]): AgentTranscriptMessage[] {
  const projected: AgentTranscriptMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    if (record.role !== "user" && record.role !== "assistant") continue;
    const blocks = projectContent(record.content);
    if (blocks.length === 0) continue;
    projected.push({
      id: typeof record.id === "string" ? record.id : `${record.role}:${index}`,
      role: record.role,
      blocks,
    });
  }
  return projected;
}

function projectContent(content: unknown): AgentTranscriptBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((item): AgentTranscriptBlock[] => {
    if (!item || typeof item !== "object") return [];
    const block = item as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      return [{ type: "text", text: block.text }];
    }
    if (block.type === "toolCall" && typeof block.name === "string") {
      return [{
        type: "tool",
        id: typeof block.id === "string" ? block.id : block.name,
        name: block.name,
        status: "running",
      }];
    }
    return [];
  });
}
