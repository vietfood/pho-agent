import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  AgentCapabilities,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SessionConfigOption,
  SessionConfigSelectOption,
  SessionUpdate,
  ToolCall,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type { AgentBackendAdapter, AgentScopeAdapter } from "@pho-agent/host";
import {
  agentScopeKeyId,
  normalizeAgentScopeKey,
  requireAgentId,
  type AgentBackendDescriptor,
  type AgentInteractionRequest,
  type AgentInteractionResolution,
  type AgentModelState,
  type AgentRuntimeEvent,
  type AgentScopeKey,
  type AgentSessionSnapshot,
  type AgentToolBlock,
  type AgentTranscriptMessage,
} from "@pho-agent/protocol";
import { createAcpStdioClient, type AcpClient } from "./client";

export interface CreateAcpBackendOptions {
  id: string;
  label: string;
  scope: AgentScopeAdapter;
  client?: AcpClient;
  command?: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

export function createLazyAcpBackend(options: CreateAcpBackendOptions): AgentBackendAdapter {
  const listeners = new Set<(event: AgentRuntimeEvent) => void>();
  let resolvedDescriptor: AgentBackendDescriptor = {
    id: requireAgentId(options.id, "backendId"),
    label: requireAgentId(options.label, "backend label"),
    capabilities: {},
  };
  let backend: Promise<AgentBackendAdapter> | undefined;
  let unsubscribe: (() => void) | undefined;
  let disposed = false;

  const load = async (): Promise<AgentBackendAdapter> => {
    if (disposed) throw new Error("The ACP backend is disposed.");
    backend ??= createAcpBackend(options).then((created) => {
      resolvedDescriptor = created.descriptor;
      unsubscribe = created.subscribe((event) => {
        for (const listener of listeners) listener(event);
      });
      return created;
    });
    return backend;
  };

  return {
    get descriptor() { return resolvedDescriptor; },
    getSessionSnapshot: async (key) => (await load()).getSessionSnapshot(key),
    createSession: async (scopeId) => (await load()).createSession(scopeId),
    openSession: async (key) => (await load()).openSession(key),
    setModel: async (input) => {
      const created = await load();
      if (!created.setModel) throw new Error("The ACP backend does not support model selection.");
      return created.setModel(input);
    },
    setReasoning: async (input) => {
      const created = await load();
      if (!created.setReasoning) throw new Error("The ACP backend does not support reasoning selection.");
      return created.setReasoning(input);
    },
    setFastMode: async (input) => {
      const created = await load();
      if (!created.setFastMode) throw new Error("The ACP backend does not support Fast mode.");
      return created.setFastMode(input);
    },
    sendPrompt: async (input) => (await load()).sendPrompt(input),
    abortRun: async (input) => (await load()).abortRun(input),
    resolveInteraction: async (input) => {
      const created = await load();
      if (!created.resolveInteraction) throw new Error("The ACP backend does not support interactions.");
      return created.resolveInteraction(input);
    },
    subscribe(listener) {
      if (disposed) throw new Error("The ACP backend is disposed.");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      listeners.clear();
      const created = await backend?.catch(() => undefined);
      await created?.dispose();
    },
  };
}

interface LiveSession {
  key: AgentScopeKey;
  run: AgentSessionSnapshot["run"];
  messages: AgentTranscriptMessage[];
  assistantByRun: Map<string, number>;
  configOptions: SessionConfigOption[];
}

interface PendingAcpPermission {
  live: LiveSession;
  request: AgentInteractionRequest & { kind: "approval" };
  resolve(value: RequestPermissionResponse): void;
}

export async function createAcpBackend(options: CreateAcpBackendOptions): Promise<AgentBackendAdapter> {
  const client = options.client ?? createAcpStdioClient({
    command: options.command ?? requireCommand(),
    args: options.args,
    env: options.env,
  });
  let initialization: Awaited<ReturnType<AcpClient["initialize"]>>;
  try {
    initialization = await client.initialize();
  } catch (error) {
    await client.dispose();
    throw error;
  }
  const descriptor = acpDescriptor(options.id, options.label, initialization.agentCapabilities);
  const sessions = new Map<string, LiveSession>();
  const sessionsById = new Map<string, LiveSession>();
  const pendingPermissions = new Map<string, PendingAcpPermission>();
  const listeners = new Set<(event: AgentRuntimeEvent) => void>();
  let disposed = false;

  function requireAvailable(): void {
    if (disposed) throw new Error("The ACP backend is disposed.");
  }

  function emit(event: AgentRuntimeEvent): void {
    for (const listener of listeners) listener(event);
  }

  function snapshot(live: LiveSession): AgentSessionSnapshot {
    const model = projectModelState(live.configOptions);
    const reasoning = projectReasoningState(live.configOptions);
    const fastMode = projectFastMode(live.configOptions);
    return {
      key: live.key,
      run: { ...live.run },
      messages: structuredClone(live.messages),
      ...(model ? { model } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(fastMode ? { fastMode } : {}),
    };
  }

  function publish(live: LiveSession): AgentSessionSnapshot {
    const value = snapshot(live);
    emit({ ...live.key, type: "session_snapshot", occurredAt: new Date().toISOString(), snapshot: value });
    return value;
  }

  async function resolveScope(scopeIdInput: string): Promise<{ scopeId: string; cwd: string }> {
    const scopeId = requireAgentId(scopeIdInput, "scopeId");
    const resolution = await options.scope.resolve(scopeId);
    if (!resolution || typeof resolution.runtimeDirectory !== "string") {
      throw new TypeError("The product scope adapter returned no runtime directory.");
    }
    return { scopeId, cwd: path.resolve(resolution.runtimeDirectory) };
  }

  function register(keyInput: AgentScopeKey, configOptions: SessionConfigOption[]): LiveSession {
    const key = normalizeAgentScopeKey(keyInput);
    const existing = sessions.get(agentScopeKeyId(key));
    if (existing) {
      existing.configOptions = configOptions;
      return existing;
    }
    const live: LiveSession = {
      key,
      run: { status: "idle" },
      messages: [],
      assistantByRun: new Map(),
      configOptions,
    };
    sessions.set(agentScopeKeyId(key), live);
    sessionsById.set(key.sessionId, live);
    return live;
  }

  function requireSession(keyInput: AgentScopeKey): LiveSession {
    const key = normalizeAgentScopeKey(keyInput);
    const live = sessions.get(agentScopeKeyId(key));
    if (!live) throw new Error(`ACP session is not open: ${key.sessionId}.`);
    return live;
  }

  function assistantMessage(live: LiveSession, runId: string): AgentTranscriptMessage {
    const existing = live.assistantByRun.get(runId);
    if (existing !== undefined) return live.messages[existing]!;
    const message: AgentTranscriptMessage = { id: `acp:${runId}`, role: "assistant", blocks: [] };
    live.assistantByRun.set(runId, live.messages.length);
    live.messages.push(message);
    return message;
  }

  function onUpdate(notification: SessionNotification): void {
    const live = sessionsById.get(notification.sessionId);
    if (!live) return;
    if (notification.update.sessionUpdate === "config_option_update") {
      live.configOptions = notification.update.configOptions;
      publish(live);
      return;
    }
    const runId = live.run.runId;
    if (!runId) return;
    const tool = projectUpdate(assistantMessage(live, runId), notification.update);
    if (notification.update.sessionUpdate === "agent_message_chunk" && notification.update.content.type === "text") {
      emit({
        ...live.key,
        type: "text_delta",
        runId,
        delta: bounded(notification.update.content.text),
        occurredAt: new Date().toISOString(),
      });
      return;
    }
    if (tool) {
      emit({ ...live.key, type: "tool_update", runId, tool, occurredAt: new Date().toISOString() });
      return;
    }
    publish(live);
  }

  function onPermission(input: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const live = sessionsById.get(input.sessionId);
    const runId = live?.run.runId;
    if (!live || !runId) return Promise.resolve(cancelledPermission());
    const interactionOptions = permissionOptions(input);
    if (interactionOptions.length === 0) return Promise.resolve(cancelledPermission());
    const requestId = `acp:${randomUUID()}`;
    const request: AgentInteractionRequest & { kind: "approval" } = {
      requestId,
      kind: "approval",
      title: boundedField(input.toolCall.title ?? "Approve tool call?", 200),
      message: permissionMessage(input),
      options: interactionOptions,
    };
    return new Promise((resolve) => {
      pendingPermissions.set(requestId, { live, request, resolve });
      emit({ ...live.key, type: "interaction_requested", runId, occurredAt: new Date().toISOString(), request });
    });
  }

  function settlePermission(pending: PendingAcpPermission, response: RequestPermissionResponse): void {
    pendingPermissions.delete(pending.request.requestId);
    pending.resolve(response);
    emit({
      ...pending.live.key,
      type: "interaction_settled",
      runId: pending.live.run.runId ?? "unknown",
      occurredAt: new Date().toISOString(),
      requestId: pending.request.requestId,
    });
  }

  function cancelPermissions(live?: LiveSession): void {
    for (const pending of pendingPermissions.values()) {
      if (!live || pending.live === live) settlePermission(pending, cancelledPermission());
    }
  }

  const unsubscribe = client.subscribe(onUpdate);
  const stopPermissions = client.setPermissionHandler(onPermission);

  return {
    descriptor,
    async getSessionSnapshot(key) {
      requireAvailable();
      return snapshot(requireSession(key));
    },
    async createSession(scopeIdInput) {
      requireAvailable();
      const { scopeId, cwd } = await resolveScope(scopeIdInput);
      const session = await client.createSession(cwd);
      return publish(register({ scopeId, sessionId: session.sessionId }, session.configOptions));
    },
    async openSession(keyInput) {
      requireAvailable();
      const key = normalizeAgentScopeKey(keyInput);
      const { cwd } = await resolveScope(key.scopeId);
      const configOptions = await client.openSession(key.sessionId, cwd);
      return publish(register(key, configOptions));
    },
    async setModel(input) {
      requireAvailable();
      const live = requireSession(input);
      if (live.run.status === "running") {
        throw new Error("Wait for the current run to finish before changing the model.");
      }
      const config = modelConfig(live.configOptions);
      if (!config || !modelOptions(config).some((option) => option.value === input.modelId)) {
        throw new Error(`ACP model ${input.modelId} is not available.`);
      }
      live.configOptions = await client.setSessionConfigOption(
        live.key.sessionId,
        config.id,
        input.modelId,
      );
      return publish(live);
    },
    async setReasoning(input) {
      requireAvailable();
      const live = requireSession(input);
      if (live.run.status === "running") throw new Error("Wait for the current run to finish before changing reasoning.");
      const config = reasoningConfig(live.configOptions);
      if (!config || !modelOptions(config).some((option) => option.value === input.reasoningId)) {
        throw new Error(`ACP reasoning level ${input.reasoningId} is not available.`);
      }
      live.configOptions = await client.setSessionConfigOption(live.key.sessionId, config.id, input.reasoningId);
      return publish(live);
    },
    async setFastMode(input) {
      requireAvailable();
      const live = requireSession(input);
      if (live.run.status === "running") throw new Error("Wait for the current run to finish before changing Fast mode.");
      const config = fastConfig(live.configOptions);
      if (!config) throw new Error("Fast mode is not available for this ACP session.");
      const value = input.enabled ? "on" : "off";
      if (!modelOptions(config).some((option) => option.value === value)) {
        throw new Error(`ACP Fast mode cannot be turned ${value}.`);
      }
      live.configOptions = await client.setSessionConfigOption(live.key.sessionId, config.id, value);
      return publish(live);
    },
    async sendPrompt(input) {
      requireAvailable();
      const live = requireSession(input);
      if (live.run.status === "running") throw new Error("The ACP session already has an active run.");
      const runId = randomUUID();
      live.messages.push({ id: `acp-user:${runId}`, role: "user", blocks: [{ type: "text", text: input.text }] });
      live.run = { status: "running", runId };
      const occurredAt = new Date().toISOString();
      emit({ ...live.key, type: "run_started", runId, occurredAt });
      publish(live);
      void client.prompt(live.key.sessionId, input.text).then((response) => {
        if (live.run.runId !== runId) return;
        cancelPermissions(live);
        live.run = response.stopReason === "cancelled"
          ? { status: "cancelled", runId }
          : { status: "settled", runId };
        const type = response.stopReason === "cancelled" ? "run_cancelled" : "run_settled";
        emit({ ...live.key, type, runId, occurredAt: new Date().toISOString() });
        publish(live);
      }, (error: unknown) => {
        if (live.run.runId !== runId) return;
        cancelPermissions(live);
        const message = error instanceof Error ? error.message : String(error);
        live.run = { status: "failed", runId, error: bounded(message) };
        emit({ ...live.key, type: "run_failed", runId, occurredAt: new Date().toISOString(), error: bounded(message) });
        publish(live);
      });
      return { ...live.key, runId, admitted: true };
    },
    async abortRun(input) {
      requireAvailable();
      const live = requireSession(input);
      if (live.run.runId !== input.runId) throw new Error("The ACP run is no longer active.");
      cancelPermissions(live);
      await client.cancel(live.key.sessionId);
    },
    async resolveInteraction(input) {
      requireAvailable();
      const live = requireSession(input);
      const pending = pendingPermissions.get(input.requestId);
      if (!pending || pending.live !== live) throw new Error("That ACP permission is not pending for this session.");
      settlePermission(pending, acpPermissionResponse(pending, input));
    },
    subscribe(listener) {
      requireAvailable();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      stopPermissions();
      cancelPermissions();
      listeners.clear();
      sessions.clear();
      sessionsById.clear();
      await client.dispose();
    },
  };
}

function permissionMessage(input: RequestPermissionRequest): string {
  const name = (input.toolCall.name ?? input.toolCall.title ?? "tool").replaceAll("'", "’");
  const detail = json(input.toolCall.rawInput);
  return bounded(
    `Current agent requested tool '${name}'${detail ? ` with input \`${detail}\`` : ""}. Allow this tool?`,
  );
}

function permissionOptions(input: RequestPermissionRequest): Array<{ value: string; label: string }> {
  if (
    input.options.length === 0 ||
    input.options.length > 9 ||
    input.options.some((option) => !option.optionId || option.optionId.length > 512 || !option.name.trim())
  ) return [];
  const labels = new Map<string, number>();
  return input.options.map((option) => {
    const base = boundedField(option.name.trim(), 120);
    const occurrence = (labels.get(base) ?? 0) + 1;
    labels.set(base, occurrence);
    return { value: option.optionId, label: occurrence === 1 ? base : `${base} (${occurrence})` };
  });
}

function acpPermissionResponse(
  pending: PendingAcpPermission,
  resolution: AgentInteractionResolution,
): RequestPermissionResponse {
  if (resolution.cancelled === true) return cancelledPermission();
  const selected = pending.request.options.find((option) => option.value === resolution.selected);
  return selected
    ? { outcome: { outcome: "selected", optionId: selected.value } }
    : cancelledPermission();
}

function cancelledPermission(): RequestPermissionResponse {
  return { outcome: { outcome: "cancelled" } };
}

function acpDescriptor(id: string, label: string, capabilities?: AgentCapabilities): AgentBackendDescriptor {
  return {
    id: requireAgentId(id, "backendId"),
    label: requireAgentId(label, "backend label"),
    capabilities: {
      "model-selection": "experimental",
      "reasoning-selection": "experimental",
      "fast-mode": "experimental",
      plans: "experimental",
      approvals: "native",
      ...(capabilities?.promptCapabilities?.image ? { images: "native" as const } : {}),
      ...(capabilities?.mcpCapabilities ? { mcp: "native" as const } : {}),
      ...(capabilities?.sessionCapabilities?.fork ? { "session-forking": "experimental" as const } : {}),
    },
  };
}

function modelConfig(configOptions: SessionConfigOption[]): Extract<SessionConfigOption, { type: "select" }> | undefined {
  return configOptions.find(
    (option): option is Extract<SessionConfigOption, { type: "select" }> =>
      option.type === "select" && option.category === "model",
  );
}

function reasoningConfig(configOptions: SessionConfigOption[]): Extract<SessionConfigOption, { type: "select" }> | undefined {
  return configOptions.find(
    (option): option is Extract<SessionConfigOption, { type: "select" }> =>
      option.type === "select" && option.category === "thought_level",
  );
}

function fastConfig(configOptions: SessionConfigOption[]): Extract<SessionConfigOption, { type: "select" }> | undefined {
  return configOptions.find(
    (option): option is Extract<SessionConfigOption, { type: "select" }> =>
      option.type === "select" && option.id === "fast",
  );
}

function modelOptions(config: Extract<SessionConfigOption, { type: "select" }>): SessionConfigSelectOption[] {
  return config.options.flatMap((option) => "value" in option ? [option] : option.options);
}

function projectModelState(configOptions: SessionConfigOption[]): AgentModelState | undefined {
  const config = modelConfig(configOptions);
  if (!config) return undefined;
  return {
    currentId: config.currentValue,
    available: modelOptions(config).map((option) => ({
      id: option.value,
      label: option.name,
      ...(option.description ? { description: option.description } : {}),
    })),
  };
}

function projectReasoningState(configOptions: SessionConfigOption[]): AgentSessionSnapshot["reasoning"] {
  const config = reasoningConfig(configOptions);
  if (!config) return undefined;
  return {
    currentId: config.currentValue,
    available: modelOptions(config).map((option) => ({
      id: option.value,
      label: option.name,
      ...(option.description ? { description: option.description } : {}),
    })),
  };
}

function projectFastMode(configOptions: SessionConfigOption[]): AgentSessionSnapshot["fastMode"] {
  const config = fastConfig(configOptions);
  if (!config) return undefined;
  return {
    enabled: config.currentValue === "on",
    ...(config.description ? { description: config.description } : {}),
  };
}

function projectUpdate(message: AgentTranscriptMessage, update: SessionUpdate): AgentToolBlock | undefined {
  if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
    const id = update.messageId ?? "agent-message";
    const existing = message.blocks.find((block) => block.type === "text" && block.id === id);
    if (existing?.type === "text") existing.text = bounded(existing.text + update.content.text);
    else message.blocks.push({ type: "text", id, text: bounded(update.content.text) });
    return undefined;
  }
  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    return upsertTool(message, update);
  }
  if (update.sessionUpdate === "plan" || update.sessionUpdate === "plan_update") {
    return upsertTool(message, {
      toolCallId: "acp-plan",
      title: "Plan",
      kind: "think",
      status: "completed",
      rawOutput: update,
    });
  }
  if (update.sessionUpdate === "compaction_update" || update.sessionUpdate === "compaction_summary_chunk") {
    return upsertTool(message, {
      toolCallId: "acp-compaction",
      title: "Context compaction",
      kind: "think",
      status: update.sessionUpdate === "compaction_update" ? "completed" : "in_progress",
      rawOutput: update,
    });
  }
  return undefined;
}

function upsertTool(message: AgentTranscriptMessage, update: ToolCall | ToolCallUpdate): AgentToolBlock {
  const index = message.blocks.findIndex((block) => block.type === "tool" && block.id === update.toolCallId);
  const existing = index >= 0 ? message.blocks[index] : undefined;
  const prior = existing?.type === "tool" ? existing : undefined;
  const title = update.title ?? prior?.title;
  const kind = acpToolKind(update.kind) ?? prior?.kind;
  const input = json(update.rawInput) ?? prior?.input;
  const outputDelta = terminalOutputDelta(update);
  const output = outputDelta !== undefined
    ? bounded((prior?.output ?? "") + outputDelta)
    : json(update.rawOutput) ?? prior?.output;
  const block: AgentToolBlock = {
    type: "tool",
    id: update.toolCallId,
    name: update.name ?? prior?.name ?? title ?? "Tool",
    status: acpToolStatus(update.status) ?? prior?.status ?? "running",
    ...(title ? { title } : {}),
    ...(kind ? { kind } : {}),
    ...(input ? { input } : {}),
    ...(output ? { output } : {}),
  };
  if (index < 0) message.blocks.push(block);
  else message.blocks[index] = block;
  return block;
}

function terminalOutputDelta(update: ToolCall | ToolCallUpdate): string | undefined {
  const meta = update._meta;
  if (!meta || typeof meta !== "object") return undefined;
  const terminalOutput = (meta as Record<string, unknown>).terminal_output;
  if (!terminalOutput || typeof terminalOutput !== "object") return undefined;
  const data = (terminalOutput as Record<string, unknown>).data;
  return typeof data === "string" ? data : undefined;
}

function acpToolKind(kind: ToolCall["kind"] | null | undefined): AgentToolBlock["kind"] | undefined {
  if (kind === "execute") return "command";
  if (kind === "edit" || kind === "delete" || kind === "move") return "file-change";
  if (kind === "search" || kind === "fetch") return "web-search";
  return kind ? "other" : undefined;
}

function acpToolStatus(status: ToolCall["status"] | null | undefined): AgentToolBlock["status"] | undefined {
  if (status === "completed" || status === "failed") return status;
  return status ? "running" : undefined;
}

function json(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    return bounded(JSON.stringify(value));
  } catch {
    return "[unserializable]";
  }
}

function bounded(value: string): string {
  return value.length <= 32_768 ? value : `${value.slice(0, 32_767)}…`;
}

function boundedField(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function requireCommand(): never {
  throw new Error("An ACP backend requires a source-controlled agent command.");
}
