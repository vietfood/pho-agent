import path from "node:path";
import type { AgentBackendAdapter, AgentScopeAdapter } from "@pho-agent/host";
import {
  agentScopeKeyId,
  normalizeAgentScopeKey,
  requireAgentId,
  type AgentBackendDescriptor,
  type AgentInteractionRequest,
  type AgentInteractionResolution,
  type AgentModelOption,
  type AgentRuntimeEvent,
  type AgentScopeKey,
  type AgentSessionSnapshot,
  type AgentToolBlock,
  type AgentTranscriptBlock,
  type AgentTranscriptMessage,
} from "@pho-agent/protocol";
import {
  createCodexStdioConnection,
  type CodexAppServerConnection,
  type CodexNotification,
  type CodexServerRequest,
} from "./connection";
import type {
  CodexDynamicToolSpec,
  CodexModelListResponse,
  CodexThread,
  CodexThreadItem,
  CodexThreadResponse,
  CodexTurn,
  CodexTurnResponse,
} from "./wire";

export const CODEX_BACKEND_DESCRIPTOR: AgentBackendDescriptor = {
  id: "codex",
  label: "Codex",
  capabilities: {
    "model-selection": "experimental",
    "reasoning-selection": "native",
    "fast-mode": "native",
    steering: "experimental",
    approvals: "experimental",
    images: "experimental",
    "session-forking": "experimental",
    plans: "experimental",
    goals: "experimental",
    "native-review": "experimental",
    skills: "experimental",
    mcp: "experimental",
    "dynamic-tools": "experimental",
    "structured-file-changes": "experimental",
  },
};

export interface CodexDynamicToolCall {
  scopeId: string;
  sessionId: string;
  turnId: string;
  callId: string;
  arguments: unknown;
  signal: AbortSignal;
}

export interface CodexDynamicTool extends CodexDynamicToolSpec {
  execute(call: CodexDynamicToolCall): Promise<string>;
}

export interface CreateCodexBackendOptions {
  scope: AgentScopeAdapter;
  connection?: CodexAppServerConnection;
  command?: string;
  model?: string;
  developerInstructions?: string;
  dynamicTools?: readonly CodexDynamicTool[];
}

/** Defers process launch and protocol initialization until the backend is first used. */
export function createLazyCodexBackend(options: CreateCodexBackendOptions): AgentBackendAdapter {
  const listeners = new Set<(event: AgentRuntimeEvent) => void>();
  let backend: Promise<AgentBackendAdapter> | undefined;
  let unsubscribe: (() => void) | undefined;
  let disposed = false;

  const load = async (): Promise<AgentBackendAdapter> => {
    if (disposed) throw new Error("The Codex backend is disposed.");
    backend ??= createCodexBackend(options).then((created) => {
      unsubscribe = created.subscribe((event) => {
        for (const listener of listeners) listener(event);
      });
      return created;
    });
    return backend;
  };

  return {
    descriptor: CODEX_BACKEND_DESCRIPTOR,
    getSessionSnapshot: async (key) => (await load()).getSessionSnapshot(key),
    createSession: async (scopeId) => (await load()).createSession(scopeId),
    openSession: async (key) => (await load()).openSession(key),
    setModel: async (input) => {
      const created = await load();
      if (!created.setModel) throw new Error("The Codex backend does not support model selection.");
      return created.setModel(input);
    },
    setReasoning: async (input) => {
      const created = await load();
      if (!created.setReasoning) throw new Error("The Codex backend does not support reasoning selection.");
      return created.setReasoning(input);
    },
    setFastMode: async (input) => {
      const created = await load();
      if (!created.setFastMode) throw new Error("The Codex backend does not support Fast mode.");
      return created.setFastMode(input);
    },
    sendPrompt: async (input) => (await load()).sendPrompt(input),
    steerRun: async (input) => {
      const created = await load();
      if (!created.steerRun) throw new Error("The Codex backend does not support steering.");
      return created.steerRun(input);
    },
    abortRun: async (input) => (await load()).abortRun(input),
    resolveInteraction: async (input) => {
      const created = await load();
      if (!created.resolveInteraction) throw new Error("The Codex backend does not support interactions.");
      return created.resolveInteraction(input);
    },
    subscribe(listener) {
      if (disposed) throw new Error("The Codex backend is disposed.");
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
  assistantByTurn: Map<string, number>;
  modelId?: string;
  reasoningId?: string;
  fastMode: boolean;
}

interface PendingCodexInteraction {
  live: LiveSession;
  method: string;
  params: Record<string, unknown>;
  request: AgentInteractionRequest;
  resolve(value: unknown): void;
}

interface PendingDynamicToolCall {
  live: LiveSession;
  controller: AbortController;
}

export async function createCodexBackend(options: CreateCodexBackendOptions): Promise<AgentBackendAdapter> {
  const dynamicTools = normalizeDynamicTools(options.dynamicTools ?? []);
  const connection = options.connection ?? createCodexStdioConnection(options.command);
  try {
    await connection.request("initialize", {
      clientInfo: { name: "pho_code", title: "Pho Code", version: "0.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
  } catch (error) {
    await connection.dispose();
    throw error;
  }
  connection.notify("initialized");

  const models = await discoverModels(connection, options.model);
  const defaultModelId = options.model ?? models.find((model) => model.isDefault)?.id ?? models[0]?.id;
  const dynamicToolByName = new Map(dynamicTools.map((tool) => [tool.name, tool]));

  const sessions = new Map<string, LiveSession>();
  const sessionsById = new Map<string, LiveSession>();
  const pendingInteractions = new Map<string, PendingCodexInteraction>();
  const pendingDynamicTools = new Map<string, PendingDynamicToolCall>();
  const listeners = new Set<(event: AgentRuntimeEvent) => void>();
  let disposed = false;

  function requireAvailable(): void {
    if (disposed) throw new Error("The Codex backend is disposed.");
  }

  function emit(event: AgentRuntimeEvent): void {
    for (const listener of listeners) listener(event);
  }

  function snapshot(live: LiveSession): AgentSessionSnapshot {
    const selected = models.find((model) => model.id === live.modelId);
    const fast = selected?.serviceTiers.find((tier) => tier.id === "fast");
    return {
      key: live.key,
      run: { ...live.run },
      messages: structuredClone(live.messages),
      ...(models.length > 0 ? {
        model: {
          available: models.map(({ isDefault: _isDefault, reasoning: _reasoning, defaultReasoningId: _defaultReasoningId, serviceTiers: _serviceTiers, ...model }) => model),
          ...(live.modelId ? { currentId: live.modelId } : {}),
        },
      } : {}),
      ...(selected?.reasoning.length ? {
        reasoning: {
          available: selected.reasoning,
          ...(live.reasoningId ? { currentId: live.reasoningId } : {}),
        },
      } : {}),
      ...(fast ? {
        fastMode: {
          enabled: live.fastMode,
          ...(fast.description ? { description: fast.description } : {}),
        },
      } : {}),
    };
  }

  function publish(live: LiveSession): AgentSessionSnapshot {
    const value = snapshot(live);
    emit({ ...live.key, type: "session_snapshot", occurredAt: new Date().toISOString(), snapshot: value });
    return value;
  }

  function emitToolUpdate(live: LiveSession, runId: string, tool: AgentToolBlock): void {
    emit({
      ...live.key,
      type: "tool_update",
      runId,
      tool: structuredClone(tool),
      occurredAt: new Date().toISOString(),
    });
  }

  async function resolveScope(scopeIdInput: string): Promise<{ scopeId: string; cwd: string }> {
    const scopeId = requireAgentId(scopeIdInput, "scopeId");
    const resolution = await options.scope.resolve(scopeId);
    if (!resolution || typeof resolution.runtimeDirectory !== "string") {
      throw new TypeError("The product scope adapter returned no runtime directory.");
    }
    return { scopeId, cwd: path.resolve(resolution.runtimeDirectory) };
  }

  function register(scopeId: string, thread: CodexThread): LiveSession {
    const key = normalizeAgentScopeKey({ scopeId, sessionId: thread.id });
    const live: LiveSession = {
      key,
      run: { status: "idle" },
      messages: [],
      assistantByTurn: new Map(),
      modelId: thread.model ?? defaultModelId,
      reasoningId: thread.reasoningEffort ?? selectedModel(models, thread.model ?? defaultModelId)?.defaultReasoningId,
      fastMode: thread.serviceTier === "fast",
    };
    for (const turn of thread.turns ?? []) projectTurn(live, turn);
    sessions.set(agentScopeKeyId(key), live);
    sessionsById.set(key.sessionId, live);
    return live;
  }

  function requireSession(keyInput: AgentScopeKey): LiveSession {
    const key = normalizeAgentScopeKey(keyInput);
    const live = sessions.get(agentScopeKeyId(key));
    if (!live) throw new Error(`Codex session is not open: ${key.sessionId}.`);
    return live;
  }

  function appendUserMessage(live: LiveSession, id: string, text: string): void {
    live.messages.push({ id, role: "user", blocks: [{ type: "text", text }] });
  }

  function assistantMessage(live: LiveSession, turnId: string): AgentTranscriptMessage {
    const existing = live.assistantByTurn.get(turnId);
    if (existing !== undefined) return live.messages[existing]!;
    const message: AgentTranscriptMessage = { id: `codex:${turnId}`, role: "assistant", blocks: [] };
    live.assistantByTurn.set(turnId, live.messages.length);
    live.messages.push(message);
    return message;
  }

  function projectTurn(live: LiveSession, turn: CodexTurn): void {
    for (const item of turn.items) upsertItem(live, turn.id, item, true);
    live.run = runFromTurn(turn);
  }

  function upsertItem(live: LiveSession, turnId: string, item: CodexThreadItem, completed: boolean): AgentToolBlock | undefined {
    if (item.type === "userMessage") {
      const text = item.content?.map(userInputText).filter(Boolean).join("\n") ?? "";
      if (text && !live.messages.some((message) => message.id === item.id || message.id === item.clientId)) {
        appendUserMessage(live, item.id ?? `codex-user:${turnId}`, text);
      }
      return undefined;
    }
    const block = projectItem(item, completed);
    if (!block) return undefined;
    const message = assistantMessage(live, turnId);
    const id = blockId(block);
    const index = message.blocks.findIndex((candidate) => blockId(candidate) === id);
    if (index < 0) message.blocks.push(block);
    else message.blocks[index] = block;
    return block.type === "tool" ? block : undefined;
  }

  function onNotification(notification: CodexNotification): void {
    const params = asRecord(notification.params);
    const threadId = stringField(params, "threadId");
    if (!threadId) return;
    const live = sessionsById.get(threadId);
    if (!live) return;
    if (notification.method === "serverRequest/resolved") {
      const requestId = interactionId(params.requestId);
      const pending = pendingInteractions.get(requestId);
      if (pending) settleInteraction(pending, cancellationResponse(pending.method));
      return;
    }
    if (notification.method === "turn/started") {
      const turn = params.turn as CodexTurn | undefined;
      if (!turn?.id) return;
      live.run = { status: "running", runId: turn.id };
      emit({ ...live.key, type: "run_started", runId: turn.id, occurredAt: new Date().toISOString() });
      publish(live);
      return;
    }
    if (notification.method === "item/started" || notification.method === "item/completed") {
      const turnId = stringField(params, "turnId");
      const item = params.item as CodexThreadItem | undefined;
      if (!turnId || !item?.type) return;
      const tool = upsertItem(live, turnId, item, notification.method === "item/completed");
      if (tool) emitToolUpdate(live, turnId, tool);
      else publish(live);
      return;
    }
    if (notification.method === "item/commandExecution/outputDelta") {
      const turnId = stringField(params, "turnId");
      const itemId = stringField(params, "itemId");
      const delta = stringField(params, "delta");
      if (!turnId || !itemId || delta === undefined) return;
      const message = assistantMessage(live, turnId);
      const existing = message.blocks.find((block) => block.type === "tool" && block.id === itemId);
      const tool = existing?.type === "tool"
        ? { ...existing, output: bounded((existing.output ?? "") + delta) }
        : toolBlock(itemId, "Command", "command", "running", undefined, delta);
      const index = message.blocks.findIndex((block) => block.type === "tool" && block.id === itemId);
      if (index < 0) message.blocks.push(tool);
      else message.blocks[index] = tool;
      emitToolUpdate(live, turnId, tool);
      return;
    }
    if (notification.method === "item/agentMessage/delta") {
      const turnId = stringField(params, "turnId");
      const itemId = stringField(params, "itemId");
      const delta = stringField(params, "delta");
      if (!turnId || !itemId || delta === undefined) return;
      const message = assistantMessage(live, turnId);
      const existing = message.blocks.find((block) => block.type === "text" && block.id === itemId);
      const boundedDelta = bounded(delta);
      if (existing?.type === "text") existing.text = bounded(existing.text + boundedDelta);
      else message.blocks.push({ type: "text", id: itemId, text: boundedDelta });
      emit({ ...live.key, type: "text_delta", runId: turnId, delta: boundedDelta, occurredAt: new Date().toISOString() });
      return;
    }
    if (notification.method === "turn/completed") {
      const turn = params.turn as CodexTurn | undefined;
      if (!turn?.id) return;
      cancelInteractions(live);
      cancelDynamicTools(live);
      projectTurn(live, turn);
      const occurredAt = new Date().toISOString();
      if (live.run.status === "failed") {
        emit({ ...live.key, type: "run_failed", runId: turn.id, occurredAt, error: live.run.error ?? "Codex turn failed." });
      } else if (live.run.status === "cancelled") {
        emit({ ...live.key, type: "run_cancelled", runId: turn.id, occurredAt });
      } else {
        emit({ ...live.key, type: "run_settled", runId: turn.id, occurredAt });
      }
      publish(live);
    }
  }

  async function onServerRequest(serverRequest: CodexServerRequest): Promise<unknown> {
    const params = asRecord(serverRequest.params);
    if (serverRequest.method === "currentTime/read") {
      return { currentTimeAt: Math.floor(Date.now() / 1_000) };
    }
    const threadId = stringField(params, "threadId") ?? stringField(params, "conversationId");
    const live = threadId ? sessionsById.get(threadId) : undefined;
    if (!live) throw new Error("The Codex server request does not belong to an open session.");
    if (serverRequest.method === "item/tool/call") {
      return executeDynamicTool(live, params);
    }
    const requestId = interactionId(serverRequest.id);
    const request = projectInteraction(requestId, serverRequest.method, params);
    if (!request) throw new Error(`Unsupported Codex server request: ${serverRequest.method}.`);
    return new Promise((resolve) => {
      const pending: PendingCodexInteraction = { live, method: serverRequest.method, params, request, resolve };
      pendingInteractions.set(requestId, pending);
      emit({
        ...live.key,
        type: "interaction_requested",
        runId: stringField(params, "turnId") ?? live.run.runId ?? "unknown",
        occurredAt: new Date().toISOString(),
        request,
      });
    });
  }

  async function executeDynamicTool(
    live: LiveSession,
    params: Record<string, unknown>,
  ): Promise<{ contentItems: Array<{ type: "inputText"; text: string }>; success: boolean }> {
    const callId = stringField(params, "callId");
    const turnId = stringField(params, "turnId");
    const toolName = stringField(params, "tool");
    const tool = toolName ? dynamicToolByName.get(toolName) : undefined;
    const pendingKey = callId ? JSON.stringify([live.key.sessionId, callId]) : "";
    if (!callId || !turnId || !tool || pendingDynamicTools.has(pendingKey)) {
      return dynamicToolResponse(false, "Pho Code rejected an unknown or duplicate dynamic tool call.");
    }
    if (live.run.runId && live.run.runId !== turnId) {
      return dynamicToolResponse(false, "Pho Code rejected a dynamic tool call for a stale turn.");
    }
    const controller = new AbortController();
    pendingDynamicTools.set(pendingKey, { live, controller });
    try {
      const output = await tool.execute({
        scopeId: live.key.scopeId,
        sessionId: live.key.sessionId,
        turnId,
        callId,
        arguments: params.arguments,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return dynamicToolResponse(false, "Pho Code cancelled the dynamic tool call.");
      return dynamicToolResponse(true, output);
    } catch (error) {
      return dynamicToolResponse(false, error instanceof Error ? error.message : "The Pho Code tool failed.");
    } finally {
      pendingDynamicTools.delete(pendingKey);
    }
  }

  function settleInteraction(pending: PendingCodexInteraction, response: unknown): void {
    pendingInteractions.delete(pending.request.requestId);
    pending.resolve(response);
    emit({
      ...pending.live.key,
      type: "interaction_settled",
      runId: stringField(pending.params, "turnId") ?? pending.live.run.runId ?? "unknown",
      occurredAt: new Date().toISOString(),
      requestId: pending.request.requestId,
    });
  }

  function cancelInteractions(live?: LiveSession): void {
    for (const pending of pendingInteractions.values()) {
      if (!live || pending.live === live) settleInteraction(pending, cancellationResponse(pending.method));
    }
  }

  function cancelDynamicTools(live?: LiveSession): void {
    for (const pending of pendingDynamicTools.values()) {
      if (!live || pending.live === live) pending.controller.abort();
    }
  }

  const unsubscribe = connection.subscribe(onNotification);
  const stopRequests = connection.setRequestHandler(onServerRequest);

  return {
    descriptor: CODEX_BACKEND_DESCRIPTOR,
    async getSessionSnapshot(key) {
      requireAvailable();
      return snapshot(requireSession(key));
    },
    async createSession(scopeIdInput) {
      requireAvailable();
      const { scopeId, cwd } = await resolveScope(scopeIdInput);
      const response = await connection.request("thread/start", {
        cwd,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        ...(options.developerInstructions ? { developerInstructions: bounded(options.developerInstructions) } : {}),
        ...(dynamicTools.length > 0 ? { dynamicTools: dynamicTools.map(dynamicToolSpec) } : {}),
        ...(options.model ? { model: options.model } : {}),
      }) as CodexThreadResponse;
      return publish(register(scopeId, response.thread));
    },
    async openSession(keyInput) {
      requireAvailable();
      const key = normalizeAgentScopeKey(keyInput);
      const { cwd } = await resolveScope(key.scopeId);
      const response = await connection.request("thread/resume", {
        threadId: key.sessionId,
        cwd,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        ...(options.developerInstructions ? { developerInstructions: bounded(options.developerInstructions) } : {}),
      }) as CodexThreadResponse;
      return publish(register(key.scopeId, response.thread));
    },
    async setModel(input) {
      requireAvailable();
      const live = requireSession(input);
      if (live.run.status === "running") {
        throw new Error("Wait for the current run to finish before changing the model.");
      }
      if (!models.some((model) => model.id === input.modelId)) {
        throw new Error(`Codex model ${input.modelId} is not available.`);
      }
      live.modelId = input.modelId;
      const model = selectedModel(models, input.modelId);
      live.reasoningId = model?.defaultReasoningId;
      live.fastMode = false;
      return publish(live);
    },
    async setReasoning(input) {
      requireAvailable();
      const live = requireSession(input);
      if (live.run.status === "running") throw new Error("Wait for the current run to finish before changing reasoning.");
      const model = selectedModel(models, live.modelId);
      if (!model?.reasoning.some((option) => option.id === input.reasoningId)) {
        throw new Error(`Codex reasoning level ${input.reasoningId} is not available.`);
      }
      live.reasoningId = input.reasoningId;
      return publish(live);
    },
    async setFastMode(input) {
      requireAvailable();
      const live = requireSession(input);
      if (live.run.status === "running") throw new Error("Wait for the current run to finish before changing Fast mode.");
      if (!selectedModel(models, live.modelId)?.serviceTiers.some((tier) => tier.id === "fast")) {
        throw new Error("Fast mode is not available for the selected Codex model.");
      }
      live.fastMode = input.enabled;
      return publish(live);
    },
    async sendPrompt(input) {
      requireAvailable();
      const live = requireSession(input);
      const clientId = crypto.randomUUID();
      appendUserMessage(live, clientId, input.text);
      const response = await connection.request("turn/start", {
        threadId: live.key.sessionId,
        ...(live.modelId ? { model: live.modelId } : {}),
        ...(live.reasoningId ? { effort: live.reasoningId } : {}),
        serviceTier: live.fastMode ? "fast" : null,
        clientUserMessageId: clientId,
        input: [{ type: "text", text: input.text, text_elements: [] }],
      }) as CodexTurnResponse;
      live.run = { status: "running", runId: response.turn.id };
      publish(live);
      return { ...live.key, runId: response.turn.id, admitted: true };
    },
    async steerRun(input) {
      requireAvailable();
      const live = requireSession(input);
      await connection.request("turn/steer", {
        threadId: live.key.sessionId,
        expectedTurnId: input.runId,
        input: [{ type: "text", text: input.text, text_elements: [] }],
      });
      return { ...live.key, runId: input.runId, admitted: true };
    },
    async abortRun(input) {
      requireAvailable();
      const live = requireSession(input);
      cancelInteractions(live);
      cancelDynamicTools(live);
      await connection.request("turn/interrupt", { threadId: live.key.sessionId, turnId: input.runId });
    },
    async resolveInteraction(input) {
      requireAvailable();
      const live = requireSession(input);
      const pending = pendingInteractions.get(input.requestId);
      if (!pending || pending.live !== live) throw new Error("That Codex interaction is not pending for this session.");
      settleInteraction(pending, interactionResponse(pending, input));
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
      stopRequests();
      cancelInteractions();
      cancelDynamicTools();
      listeners.clear();
      sessions.clear();
      sessionsById.clear();
      await connection.dispose();
    },
  };
}

interface DiscoveredCodexModel extends AgentModelOption {
  isDefault?: boolean;
  reasoning: Array<{ id: string; label: string; description?: string }>;
  defaultReasoningId?: string;
  serviceTiers: Array<{ id: string; name?: string; description?: string }>;
}

async function discoverModels(
  connection: CodexAppServerConnection,
  configuredModel?: string,
): Promise<DiscoveredCodexModel[]> {
  const discovered: DiscoveredCodexModel[] = [];
  let cursor: string | undefined;
  try {
    for (let page = 0; page < 5; page += 1) {
      const response = await connection.request("model/list", {
        limit: 100,
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      }) as CodexModelListResponse;
      for (const model of response.data ?? []) {
        const id = model.model ?? model.id;
        if (!id || id.length > 512 || discovered.some((candidate) => candidate.id === id)) continue;
        discovered.push({
          id,
          label: boundedField(model.displayName ?? id, 200),
          ...(model.description ? { description: boundedField(model.description, 1_000) } : {}),
          supportsImages: model.inputModalities?.includes("image") ?? true,
          ...(model.isDefault ? { isDefault: true } : {}),
          reasoning: (model.supportedReasoningEfforts ?? []).map((effort) => ({
            id: effort.reasoningEffort,
            label: reasoningLabel(effort.reasoningEffort),
            ...(effort.description ? { description: boundedField(effort.description, 1_000) } : {}),
          })),
          ...(model.defaultReasoningEffort ? { defaultReasoningId: model.defaultReasoningEffort } : {}),
          serviceTiers: (model.serviceTiers ?? []).map((tier) => ({
            id: tier.id,
            ...(tier.name ? { name: boundedField(tier.name, 200) } : {}),
            ...(tier.description ? { description: boundedField(tier.description, 1_000) } : {}),
          })),
        });
      }
      cursor = response.nextCursor ?? undefined;
      if (!cursor) break;
    }
  } catch {
    // Older compatible app-server versions may not expose model/list.
  }
  if (configuredModel && !discovered.some((model) => model.id === configuredModel)) {
    discovered.unshift({ id: configuredModel, label: configuredModel, reasoning: [], serviceTiers: [] });
  }
  return discovered;
}

function projectItem(item: CodexThreadItem, completed: boolean): AgentTranscriptBlock | undefined {
  const id = item.id ?? `${item.type}:unknown`;
  if (item.type === "agentMessage") return { type: "text", id, text: item.text ?? "" };
  if (item.type === "commandExecution") {
    return toolBlock(id, "Command", "command", completedStatus(item.status, completed), item.command, item.aggregatedOutput ?? undefined);
  }
  if (item.type === "fileChange") {
    return toolBlock(id, "File changes", "file-change", completedStatus(item.status, completed), json(item.changes));
  }
  if (item.type === "mcpToolCall") {
    return toolBlock(id, `${item.server ?? "MCP"}: ${item.tool ?? "tool"}`, "mcp", completedStatus(item.status, completed), json(item.arguments), json(item.error ?? item.result));
  }
  if (item.type === "dynamicToolCall") {
    const output = item.contentItems?.map(dynamicToolContentText).filter(Boolean).join("\n");
    return toolBlock(
      id,
      `Pho Code: ${item.tool ?? "tool"}`,
      "other",
      item.success === false ? "failed" : completedStatus(item.status, completed),
      json(item.arguments),
      output || undefined,
    );
  }
  if (item.type === "webSearch") {
    return toolBlock(id, "Web search", "web-search", completed ? "completed" : "running", item.query, json(item.results));
  }
  if (item.type === "imageView") return toolBlock(id, "View image", "image", completed ? "completed" : "running", item.path);
  if (item.type === "enteredReviewMode" || item.type === "exitedReviewMode") {
    return toolBlock(id, item.type === "enteredReviewMode" ? "Review started" : "Review completed", "review", "completed", item.review);
  }
  if (item.type === "contextCompaction") return toolBlock(id, "Context compacted", "other", "completed");
  if (item.type === "collabAgentToolCall" || item.type === "subAgentActivity") {
    return toolBlock(id, "Subagent activity", "subagent", completedStatus(item.status, completed), item.prompt ?? undefined, json(item.receiverThreadIds));
  }
  return undefined;
}

function normalizeDynamicTools(tools: readonly CodexDynamicTool[]): CodexDynamicTool[] {
  const normalized: CodexDynamicTool[] = [];
  const names = new Set<string>();
  for (const tool of tools) {
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(tool.name) || names.has(tool.name)) {
      throw new TypeError(`Invalid or duplicate Codex dynamic tool name: ${tool.name}.`);
    }
    if (tool.type !== "function" || !tool.description.trim() || typeof tool.execute !== "function") {
      throw new TypeError(`Invalid Codex dynamic tool definition: ${tool.name}.`);
    }
    names.add(tool.name);
    normalized.push(tool);
  }
  return normalized;
}

function dynamicToolSpec(tool: CodexDynamicTool): CodexDynamicToolSpec {
  return {
    type: "function",
    name: tool.name,
    description: boundedField(tool.description, 1_000),
    inputSchema: tool.inputSchema,
  };
}

function dynamicToolResponse(
  success: boolean,
  text: string,
): { contentItems: Array<{ type: "inputText"; text: string }>; success: boolean } {
  return { success, contentItems: [{ type: "inputText", text: bounded(text) }] };
}

function dynamicToolContentText(value: unknown): string {
  const item = asRecord(value);
  return item.type === "inputText" && typeof item.text === "string" ? item.text : "";
}

function selectedModel(
  models: readonly DiscoveredCodexModel[],
  modelId: string | undefined,
): DiscoveredCodexModel | undefined {
  return models.find((model) => model.id === modelId);
}

function reasoningLabel(id: string): string {
  if (id === "xhigh") return "Extra high";
  return id.length > 0 ? `${id[0]!.toUpperCase()}${id.slice(1)}` : id;
}

function projectInteraction(
  requestId: string,
  method: string,
  params: Record<string, unknown>,
): AgentInteractionRequest | undefined {
  if (method === "item/commandExecution/requestApproval") {
    const command = stringField(params, "command") ?? "command";
    return approvalRequest(
      requestId,
      "Approve command?",
      `Current agent requested bash command '${bounded(command)}'.${reasonSuffix(params)} Allow this command?`,
      decisionOptions(params.availableDecisions),
    );
  }
  if (method === "execCommandApproval") {
    const command = Array.isArray(params.command)
      ? params.command.filter((value): value is string => typeof value === "string").join(" ")
      : "command";
    return approvalRequest(
      requestId,
      "Approve command?",
      `Current agent requested bash command '${bounded(command)}'.${reasonSuffix(params)} Allow this command?`,
      decisionOptions(),
    );
  }
  if (method === "item/fileChange/requestApproval") {
    const grantRoot = stringField(params, "grantRoot");
    const target = grantRoot ? ` under '${bounded(grantRoot)}'` : "";
    return approvalRequest(
      requestId,
      "Approve file changes?",
      `Current agent requested tool 'file change'${target}.${reasonSuffix(params)} Allow this tool?`,
      decisionOptions(),
    );
  }
  if (method === "applyPatchApproval") {
    return approvalRequest(
      requestId,
      "Approve file changes?",
      `Current agent requested tool 'file change' with input ${bounded(json(params.fileChanges) ?? "{}")} .${reasonSuffix(params)} Allow this tool?`,
      decisionOptions(),
    );
  }
  if (method === "item/permissions/requestApproval") {
    return approvalRequest(
      requestId,
      "Approve additional access?",
      `Current agent requested tool 'permissions' with input ${bounded(json(params.permissions) ?? "{}")} .${reasonSuffix(params)} Allow this tool?`,
      decisionOptions(),
    );
  }
  if (method !== "item/tool/requestUserInput") return undefined;
  const rawQuestions = Array.isArray(params.questions) ? params.questions : [];
  if (rawQuestions.some((value) => asRecord(value).isSecret === true)) return undefined;
  const questions = rawQuestions.slice(0, 3).map((value) => {
    const question = asRecord(value);
    const options = Array.isArray(question.options)
      ? question.options.slice(0, 3).map((optionValue) => {
          const option = asRecord(optionValue);
          return {
            label: boundedField(stringField(option, "label") ?? "Option", 80),
            description: boundedField(stringField(option, "description") ?? "", 240),
          };
        })
      : [];
    return {
      header: boundedField(stringField(question, "header") ?? "Question", 12),
      question: boundedField(stringField(question, "question") ?? "The agent has a question.", 1_000),
      options,
    };
  });
  if (questions.length === 0) return undefined;
  return { requestId, kind: "questionnaire", title: questions[0]!.question, questions };
}

function approvalRequest(
  requestId: string,
  title: string,
  message: string,
  options: Array<{ value: string; label: string }>,
): AgentInteractionRequest {
  return { requestId, kind: "approval", title, message: bounded(message), options };
}

function decisionOptions(available?: unknown): Array<{ value: string; label: string }> {
  const supported = new Set(
    (Array.isArray(available) ? available : ["accept", "acceptForSession", "decline"])
      .filter((value): value is string => typeof value === "string"),
  );
  const options: Array<{ value: string; label: string }> = [];
  if (supported.has("accept")) options.push({ value: "accept", label: "Yes" });
  if (supported.has("acceptForSession")) options.push({ value: "acceptForSession", label: "Yes, for this session" });
  if (supported.has("decline")) {
    options.push({ value: "decline", label: "No" });
    options.push({ value: "decline", label: "No, provide reason" });
  }
  return options.length > 0 ? options : [{ value: "cancel", label: "Cancel" }];
}

function interactionResponse(
  pending: PendingCodexInteraction,
  resolution: AgentInteractionResolution,
): unknown {
  if (resolution.cancelled === true) return cancellationResponse(pending.method);
  if (pending.method === "item/tool/requestUserInput") {
    const questions = Array.isArray(pending.params.questions) ? pending.params.questions : [];
    const answers: Record<string, { answers: string[] }> = {};
    for (const answer of resolution.answers ?? []) {
      const id = stringField(asRecord(questions[answer.questionIndex]), "id");
      if (!id) continue;
      const values = answer.selected?.length
        ? answer.selected
        : typeof answer.answer === "string" && answer.answer.trim() ? [answer.answer] : [];
      answers[id] = { answers: values.map((value) => boundedField(value, 4_000)) };
    }
    return { answers };
  }
  const decision = resolution.selected ?? "cancel";
  if (pending.method === "execCommandApproval" || pending.method === "applyPatchApproval") {
    const legacyDecision = decision === "accept"
      ? "approved"
      : decision === "acceptForSession"
        ? "approved_for_session"
        : decision === "decline"
          ? { denied: { rejection: "Denied by user." } }
          : "abort";
    return { decision: legacyDecision };
  }
  if (pending.method === "item/permissions/requestApproval") {
    if (decision !== "accept" && decision !== "acceptForSession") {
      return { permissions: {}, scope: "turn" };
    }
    const requested = asRecord(pending.params.permissions);
    return {
      permissions: {
        ...(requested.network && typeof requested.network === "object" ? { network: requested.network } : {}),
        ...(requested.fileSystem && typeof requested.fileSystem === "object" ? { fileSystem: requested.fileSystem } : {}),
      },
      scope: decision === "acceptForSession" ? "session" : "turn",
    };
  }
  return { decision };
}

function cancellationResponse(method: string): unknown {
  if (method === "item/tool/requestUserInput") return { answers: {} };
  if (method === "item/permissions/requestApproval") return { permissions: {}, scope: "turn" };
  if (method === "execCommandApproval" || method === "applyPatchApproval") return { decision: "abort" };
  return { decision: "cancel" };
}

function interactionId(value: unknown): string {
  return `codex:${boundedField(String(value), 200)}`;
}

function reasonSuffix(params: Record<string, unknown>): string {
  const reason = stringField(params, "reason")?.trim();
  return reason ? ` ${bounded(reason)}` : "";
}

function boundedField(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function toolBlock(
  id: string,
  name: string,
  kind: AgentToolBlock["kind"],
  status: AgentToolBlock["status"],
  input?: string,
  output?: string,
): AgentToolBlock {
  return {
    type: "tool",
    id,
    name,
    kind,
    status,
    ...(input ? { input: bounded(input) } : {}),
    ...(output ? { output: bounded(output) } : {}),
  };
}

function completedStatus(status: string | undefined, completed: boolean): AgentToolBlock["status"] {
  if (status === "failed" || status === "declined") return "failed";
  return completed ? "completed" : "running";
}

function runFromTurn(turn: CodexTurn): AgentSessionSnapshot["run"] {
  if (turn.status === "failed") return { status: "failed", runId: turn.id, error: turn.error?.message ?? "Codex turn failed." };
  if (turn.status === "interrupted" || turn.status === "cancelled") return { status: "cancelled", runId: turn.id };
  if (turn.status === "inProgress") return { status: "running", runId: turn.id };
  return { status: "settled", runId: turn.id };
}

function blockId(block: AgentTranscriptBlock): string {
  return block.type === "tool" ? block.id : block.id ?? `text:${block.text}`;
}

function userInputText(value: unknown): string {
  const record = asRecord(value);
  return record.type === "text" && typeof record.text === "string" ? record.text : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined;
}

function json(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function bounded(value: string): string {
  return value.length <= 32_768 ? value : `${value.slice(0, 32_767)}…`;
}
