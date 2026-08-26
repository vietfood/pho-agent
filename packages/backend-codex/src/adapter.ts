import path from "node:path";
import type { AgentBackendAdapter, AgentScopeAdapter } from "@pho-agent/host";
import {
  agentScopeKeyId,
  normalizeAgentScopeKey,
  requireAgentId,
  type AgentBackendDescriptor,
  type AgentInteractionRequest,
  type AgentInteractionResolution,
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
import type { CodexThread, CodexThreadItem, CodexThreadResponse, CodexTurn, CodexTurnResponse } from "./wire";

export const CODEX_APP_SERVER_TESTED_VERSION = "0.149.1";

export const CODEX_BACKEND_DESCRIPTOR: AgentBackendDescriptor = {
  id: "codex",
  label: "Codex",
  capabilities: {
    steering: "experimental",
    approvals: "experimental",
    images: "experimental",
    "session-forking": "experimental",
    plans: "experimental",
    goals: "experimental",
    "native-review": "experimental",
    skills: "experimental",
    mcp: "experimental",
    "structured-file-changes": "experimental",
  },
};

export interface CreateCodexBackendOptions {
  scope: AgentScopeAdapter;
  connection?: CodexAppServerConnection;
  command?: string;
  model?: string;
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
}

interface PendingCodexInteraction {
  live: LiveSession;
  method: string;
  params: Record<string, unknown>;
  request: AgentInteractionRequest;
  resolve(value: unknown): void;
}

export async function createCodexBackend(options: CreateCodexBackendOptions): Promise<AgentBackendAdapter> {
  const connection = options.connection ?? createCodexStdioConnection(options.command);
  try {
    const initialized = await connection.request("initialize", {
      clientInfo: { name: "pho_code", title: "Pho Code", version: "0.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }) as { userAgent?: string };
    requireTestedCodexVersion(initialized.userAgent);
  } catch (error) {
    await connection.dispose();
    throw error;
  }
  connection.notify("initialized");

  const sessions = new Map<string, LiveSession>();
  const sessionsById = new Map<string, LiveSession>();
  const pendingInteractions = new Map<string, PendingCodexInteraction>();
  const listeners = new Set<(event: AgentRuntimeEvent) => void>();
  let disposed = false;

  function requireAvailable(): void {
    if (disposed) throw new Error("The Codex backend is disposed.");
  }

  function emit(event: AgentRuntimeEvent): void {
    for (const listener of listeners) listener(event);
  }

  function snapshot(live: LiveSession): AgentSessionSnapshot {
    return { key: live.key, run: { ...live.run }, messages: structuredClone(live.messages) };
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

  function register(scopeId: string, thread: CodexThread): LiveSession {
    const key = normalizeAgentScopeKey({ scopeId, sessionId: thread.id });
    const live: LiveSession = {
      key,
      run: { status: "idle" },
      messages: [],
      assistantByTurn: new Map(),
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

  function upsertItem(live: LiveSession, turnId: string, item: CodexThreadItem, completed: boolean): void {
    if (item.type === "userMessage") {
      const text = item.content?.map(userInputText).filter(Boolean).join("\n") ?? "";
      if (text && !live.messages.some((message) => message.id === item.id || message.id === item.clientId)) {
        appendUserMessage(live, item.id ?? `codex-user:${turnId}`, text);
      }
      return;
    }
    const block = projectItem(item, completed);
    if (!block) return;
    const message = assistantMessage(live, turnId);
    const id = blockId(block);
    const index = message.blocks.findIndex((candidate) => blockId(candidate) === id);
    if (index < 0) message.blocks.push(block);
    else message.blocks[index] = block;
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
      upsertItem(live, turnId, item, notification.method === "item/completed");
      publish(live);
      return;
    }
    if (notification.method === "item/agentMessage/delta") {
      const turnId = stringField(params, "turnId");
      const itemId = stringField(params, "itemId");
      const delta = stringField(params, "delta");
      if (!turnId || !itemId || delta === undefined) return;
      const message = assistantMessage(live, turnId);
      const existing = message.blocks.find((block) => block.type === "text" && block.id === itemId);
      if (existing?.type === "text") existing.text += delta;
      else message.blocks.push({ type: "text", id: itemId, text: delta });
      publish(live);
      return;
    }
    if (notification.method === "turn/completed") {
      const turn = params.turn as CodexTurn | undefined;
      if (!turn?.id) return;
      cancelInteractions(live);
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
      }) as CodexThreadResponse;
      return publish(register(key.scopeId, response.thread));
    },
    async sendPrompt(input) {
      requireAvailable();
      const live = requireSession(input);
      const clientId = crypto.randomUUID();
      appendUserMessage(live, clientId, input.text);
      const response = await connection.request("turn/start", {
        threadId: live.key.sessionId,
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
      listeners.clear();
      sessions.clear();
      sessionsById.clear();
      await connection.dispose();
    },
  };
}

function projectItem(item: CodexThreadItem, completed: boolean): AgentTranscriptBlock | undefined {
  const id = item.id ?? `${item.type}:unknown`;
  if (item.type === "agentMessage") return { type: "text", id, text: item.text ?? "" };
  if (item.type === "commandExecution") {
    return tool(id, "Command", "command", completedStatus(item.status, completed), item.command, item.aggregatedOutput ?? undefined);
  }
  if (item.type === "fileChange") {
    return tool(id, "File changes", "file-change", completedStatus(item.status, completed), json(item.changes));
  }
  if (item.type === "mcpToolCall") {
    return tool(id, `${item.server ?? "MCP"}: ${item.tool ?? "tool"}`, "mcp", completedStatus(item.status, completed), json(item.arguments), json(item.error ?? item.result));
  }
  if (item.type === "webSearch") {
    return tool(id, "Web search", "web-search", completed ? "completed" : "running", item.query, json(item.results));
  }
  if (item.type === "imageView") return tool(id, "View image", "image", completed ? "completed" : "running", item.path);
  if (item.type === "enteredReviewMode" || item.type === "exitedReviewMode") {
    return tool(id, item.type === "enteredReviewMode" ? "Review started" : "Review completed", "review", "completed", item.review);
  }
  if (item.type === "contextCompaction") return tool(id, "Context compacted", "other", "completed");
  if (item.type === "collabAgentToolCall" || item.type === "subAgentActivity") {
    return tool(id, "Subagent activity", "subagent", completedStatus(item.status, completed), item.prompt ?? undefined, json(item.receiverThreadIds));
  }
  return undefined;
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

function requireTestedCodexVersion(userAgent: string | undefined): void {
  const version = userAgent?.match(/\b(\d+\.\d+\.\d+)\b/u)?.[1];
  if (version !== CODEX_APP_SERVER_TESTED_VERSION) {
    throw new Error(
      `Pho Code supports Codex app-server ${CODEX_APP_SERVER_TESTED_VERSION}; found ${version ?? "an unknown version"}.`,
    );
  }
}

function tool(
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
