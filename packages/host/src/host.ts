import {
  normalizeAgentBackendScope,
  normalizeAgentBackendScopeKey,
  type AgentAbortInput,
  type AgentBackendAbortInput,
  type AgentBackendDescriptor,
  type AgentBackendEvent,
  type AgentBackendFollowUpInput,
  type AgentBackendInteractionResolution,
  type AgentBackendPromptAdmission,
  type AgentBackendPromptInput,
  type AgentBackendQueueAdmission,
  type AgentBackendScope,
  type AgentBackendScopeKey,
  type AgentBackendSetModelInput,
  type AgentBackendSetFastModeInput,
  type AgentBackendSetReasoningInput,
  type AgentBackendSessionSnapshot,
  type AgentBackendSteerInput,
  type AgentFollowUpInput,
  type AgentInteractionResolution,
  type AgentPromptAdmission,
  type AgentPromptInput,
  type AgentQueueAdmission,
  type AgentRuntimeEvent,
  type AgentScopeKey,
  type AgentSetModelInput,
  type AgentSetFastModeInput,
  type AgentSetReasoningInput,
  type AgentSessionSnapshot,
  type AgentSteerInput,
  type Unsubscribe,
} from "@pho-agent/protocol";
import { createAgentBackendRegistry } from "./registry";

export interface AgentBackendAdapter {
  descriptor: AgentBackendDescriptor;
  getSessionSnapshot(key: AgentScopeKey): Promise<AgentSessionSnapshot>;
  createSession(scopeId: string): Promise<AgentSessionSnapshot>;
  openSession(key: AgentScopeKey): Promise<AgentSessionSnapshot>;
  setModel?(input: AgentSetModelInput): Promise<AgentSessionSnapshot>;
  setReasoning?(input: AgentSetReasoningInput): Promise<AgentSessionSnapshot>;
  setFastMode?(input: AgentSetFastModeInput): Promise<AgentSessionSnapshot>;
  sendPrompt(input: AgentPromptInput): Promise<AgentPromptAdmission>;
  steerRun?(input: AgentSteerInput): Promise<AgentQueueAdmission>;
  queueFollowUp?(input: AgentFollowUpInput): Promise<AgentQueueAdmission>;
  abortRun(input: AgentAbortInput): Promise<void>;
  resolveInteraction?(input: AgentScopeKey & AgentInteractionResolution): Promise<void>;
  subscribe(listener: (event: AgentRuntimeEvent) => void): Unsubscribe;
  dispose(): Promise<void>;
}

export interface AgentHost {
  listBackends(): readonly AgentBackendDescriptor[];
  getSessionSnapshot(key: AgentBackendScopeKey): Promise<AgentBackendSessionSnapshot>;
  createSession(scope: AgentBackendScope): Promise<AgentBackendSessionSnapshot>;
  openSession(key: AgentBackendScopeKey): Promise<AgentBackendSessionSnapshot>;
  setModel(input: AgentBackendSetModelInput): Promise<AgentBackendSessionSnapshot>;
  setReasoning(input: AgentBackendSetReasoningInput): Promise<AgentBackendSessionSnapshot>;
  setFastMode(input: AgentBackendSetFastModeInput): Promise<AgentBackendSessionSnapshot>;
  sendPrompt(input: AgentBackendPromptInput): Promise<AgentBackendPromptAdmission>;
  steerRun(input: AgentBackendSteerInput): Promise<AgentBackendQueueAdmission>;
  queueFollowUp(input: AgentBackendFollowUpInput): Promise<AgentBackendQueueAdmission>;
  abortRun(input: AgentBackendAbortInput): Promise<void>;
  resolveInteraction(input: AgentBackendInteractionResolution): Promise<void>;
  subscribe(listener: (event: AgentBackendEvent) => void): Unsubscribe;
  dispose(): Promise<void>;
}

export function createAgentHost(adapters: readonly AgentBackendAdapter[]): AgentHost {
  const registry = createAgentBackendRegistry(adapters);
  const listeners = new Set<(event: AgentBackendEvent) => void>();
  const unsubscribers: Unsubscribe[] = [];
  let disposed = false;

  for (const { adapter, descriptor } of registry.list()) {
    unsubscribers.push(adapter.subscribe((event) => {
      const backendEvent = projectEvent(descriptor.id, event);
      for (const listener of listeners) listener(backendEvent);
    }));
  }

  function requireAvailable(): void {
    if (disposed) throw new Error("The agent host is disposed.");
  }

  function resolve(backendId: string): AgentBackendAdapter {
    requireAvailable();
    return registry.resolve(backendId).adapter;
  }

  function requireOperation<K extends "setModel" | "setReasoning" | "setFastMode" | "steerRun" | "queueFollowUp" | "resolveInteraction">(
    backendId: string,
    operation: K,
  ): NonNullable<AgentBackendAdapter[K]> {
    const adapter = resolve(backendId);
    const implementation = adapter[operation];
    if (!implementation) {
      throw new Error(`Agent backend ${backendId} does not support ${operation}.`);
    }
    return implementation.bind(adapter) as NonNullable<AgentBackendAdapter[K]>;
  }

  function scopeKey(key: AgentBackendScopeKey): AgentScopeKey {
    const normalized = normalizeAgentBackendScopeKey(key);
    return { scopeId: normalized.scopeId, sessionId: normalized.sessionId };
  }

  function snapshot(backendId: string, value: AgentSessionSnapshot): AgentBackendSessionSnapshot {
    return {
      ...value,
      key: { backendId, ...value.key },
    };
  }

  function projectEvent(backendId: string, event: AgentRuntimeEvent): AgentBackendEvent {
    if (event.type === "session_snapshot") {
      return { ...event, backendId, snapshot: snapshot(backendId, event.snapshot) };
    }
    return { ...event, backendId };
  }

  function admission<T extends AgentPromptAdmission | AgentQueueAdmission>(
    backendId: string,
    value: T,
  ): T & { backendId: string } {
    return { ...value, backendId };
  }

  return {
    listBackends() {
      requireAvailable();
      return registry.listDescriptors();
    },
    async getSessionSnapshot(key) {
      const normalized = normalizeAgentBackendScopeKey(key);
      return snapshot(normalized.backendId, await resolve(normalized.backendId).getSessionSnapshot(scopeKey(normalized)));
    },
    async createSession(scope) {
      const normalized = normalizeAgentBackendScope(scope);
      return snapshot(normalized.backendId, await resolve(normalized.backendId).createSession(normalized.scopeId));
    },
    async openSession(key) {
      const normalized = normalizeAgentBackendScopeKey(key);
      return snapshot(normalized.backendId, await resolve(normalized.backendId).openSession(scopeKey(normalized)));
    },
    async setModel(input) {
      const normalized = normalizeAgentBackendScopeKey(input);
      const value = await requireOperation(normalized.backendId, "setModel")({
        ...scopeKey(normalized),
        modelId: input.modelId,
      });
      return snapshot(normalized.backendId, value);
    },
    async setReasoning(input) {
      const normalized = normalizeAgentBackendScopeKey(input);
      const value = await requireOperation(normalized.backendId, "setReasoning")({
        ...scopeKey(normalized),
        reasoningId: input.reasoningId,
      });
      return snapshot(normalized.backendId, value);
    },
    async setFastMode(input) {
      const normalized = normalizeAgentBackendScopeKey(input);
      const value = await requireOperation(normalized.backendId, "setFastMode")({
        ...scopeKey(normalized),
        enabled: input.enabled,
      });
      return snapshot(normalized.backendId, value);
    },
    async sendPrompt(input) {
      const normalized = normalizeAgentBackendScopeKey(input);
      const value = await resolve(normalized.backendId).sendPrompt({ ...scopeKey(normalized), text: input.text });
      return admission(normalized.backendId, value);
    },
    async steerRun(input) {
      const normalized = normalizeAgentBackendScopeKey(input);
      const value = await requireOperation(normalized.backendId, "steerRun")({
        ...scopeKey(normalized),
        runId: input.runId,
        text: input.text,
      });
      return admission(normalized.backendId, value);
    },
    async queueFollowUp(input) {
      const normalized = normalizeAgentBackendScopeKey(input);
      const value = await requireOperation(normalized.backendId, "queueFollowUp")({
        ...scopeKey(normalized),
        runId: input.runId,
        text: input.text,
      });
      return admission(normalized.backendId, value);
    },
    async abortRun(input) {
      const normalized = normalizeAgentBackendScopeKey(input);
      await resolve(normalized.backendId).abortRun({ ...scopeKey(normalized), runId: input.runId });
    },
    async resolveInteraction(input) {
      const normalized = normalizeAgentBackendScopeKey(input);
      await requireOperation(normalized.backendId, "resolveInteraction")({
        ...scopeKey(normalized),
        requestId: input.requestId,
        ...(input.cancelled === true ? { cancelled: true } : {}),
        ...(input.selected !== undefined ? { selected: input.selected } : {}),
        ...(input.answers !== undefined ? { answers: input.answers } : {}),
      });
    },
    subscribe(listener) {
      requireAvailable();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const unsubscribe of unsubscribers) unsubscribe();
      listeners.clear();
      await registry.dispose();
    },
  };
}
