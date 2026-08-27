import { describe, expect, test } from "bun:test";
import type {
  CodexAppServerConnection,
  CodexNotification,
  CodexServerRequest,
  CodexServerRequestHandler,
} from "../src";
import { createCodexBackend } from "../src";

class FakeConnection implements CodexAppServerConnection {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  readonly listeners = new Set<(notification: CodexNotification) => void>();
  requestHandler: CodexServerRequestHandler | undefined;
  disposed = false;
  userAgent = "codex-cli/0.149.1";

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "initialize") return { userAgent: this.userAgent };
    if (method === "model/list") return {
      data: [
        {
          id: "gpt-5.4",
          model: "gpt-5.4",
          displayName: "GPT-5.4",
          inputModalities: ["text", "image"],
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Faster" },
            { reasoningEffort: "medium", description: "Balanced" },
            { reasoningEffort: "high", description: "Deeper" },
          ],
          serviceTiers: [{ id: "fast", name: "Fast", description: "Faster responses" }],
        },
        { id: "gpt-5.3-codex", model: "gpt-5.3-codex", displayName: "GPT-5.3 Codex", inputModalities: ["text"] },
      ],
      nextCursor: null,
    };
    if (method === "thread/start") return { thread: { id: "thread-1", turns: [] } };
    if (method === "thread/resume") {
      return {
        thread: {
          id: "thread-1",
          turns: [{
            id: "turn-old",
            status: "completed",
            items: [
              { type: "userMessage", id: "user-old", content: [{ type: "text", text: "old" }] },
              { type: "agentMessage", id: "agent-old", text: "answer" },
            ],
          }],
        },
      };
    }
    if (method === "turn/start") return { turn: { id: "turn-1", status: "inProgress", items: [] } };
    return {};
  }

  notify(method: string, params?: unknown): void {
    this.notifications.push({ method, params });
  }

  subscribe(listener: (notification: CodexNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setRequestHandler(handler: CodexServerRequestHandler): () => void {
    this.requestHandler = handler;
    return () => {
      if (this.requestHandler === handler) this.requestHandler = undefined;
    };
  }

  emit(notification: CodexNotification): void {
    for (const listener of this.listeners) listener(notification);
  }

  emitRequest(request: CodexServerRequest): Promise<unknown> {
    if (!this.requestHandler) throw new Error("No request handler is registered.");
    return this.requestHandler(request);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

const scope = { resolve: () => ({ runtimeDirectory: "/tmp/codex-workspace" }) };

describe("Codex backend adapter", () => {
  test("initializes app-server and projects a command tool lifecycle", async () => {
    const connection = new FakeConnection();
    const backend = await createCodexBackend({ connection, scope });
    expect(connection.requests[0]?.method).toBe("initialize");
    expect(connection.requests[0]?.params).toMatchObject({ capabilities: { experimentalApi: true } });
    expect(connection.notifications).toEqual([{ method: "initialized", params: undefined }]);
    expect(backend.descriptor.capabilities.steering).toBe("experimental");
    expect(backend.descriptor.capabilities.approvals).toBe("experimental");
    expect(backend.queueFollowUp).toBeUndefined();

    const created = await backend.createSession("workspace");
    const admission = await backend.sendPrompt({ ...created.key, text: "inspect" });
    expect(await connection.emitRequest({
      id: 40,
      method: "currentTime/read",
      params: { threadId: created.key.sessionId },
    })).toEqual({ currentTimeAt: expect.any(Number) });
    connection.emit({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: admission.runId,
        item: { type: "commandExecution", id: "tool-1", command: "git status", status: "inProgress" },
      },
    });
    connection.emit({
      method: "item/commandExecution/outputDelta",
      params: { threadId: "thread-1", turnId: admission.runId, itemId: "tool-1", delta: "cle" },
    });
    connection.emit({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: admission.runId,
        item: {
          type: "commandExecution",
          id: "tool-1",
          command: "git status",
          status: "completed",
          aggregatedOutput: "clean",
          exitCode: 0,
        },
      },
    });
    connection.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: admission.runId, status: "completed", items: [] },
      },
    });

    const snapshot = await backend.getSessionSnapshot(created.key);
    expect(snapshot.run.status).toBe("settled");
    expect(snapshot.messages).toEqual([
      { id: expect.any(String), role: "user", blocks: [{ type: "text", text: "inspect" }] },
      {
        id: `codex:${admission.runId}`,
        role: "assistant",
        blocks: [{
          type: "tool",
          id: "tool-1",
          name: "Command",
          kind: "command",
          status: "completed",
          input: "git status",
          output: "clean",
        }],
      },
    ]);
    await backend.dispose();
    expect(connection.disposed).toBe(true);
  });

  test("reconstructs resumed turns without reinterpreting their backend identity", async () => {
    const connection = new FakeConnection();
    const backend = await createCodexBackend({ connection, scope });
    const snapshot = await backend.openSession({ scopeId: "workspace", sessionId: "thread-1" });
    expect(snapshot.key).toEqual({ scopeId: "workspace", sessionId: "thread-1" });
    expect(snapshot.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(snapshot.messages[1]?.blocks).toEqual([{ type: "text", id: "agent-old", text: "answer" }]);
    await backend.dispose();
  });

  test("discovers models, applies a per-turn model, and emits text deltas", async () => {
    const connection = new FakeConnection();
    const backend = await createCodexBackend({ connection, scope });
    const events: Array<{ type: string; delta?: string }> = [];
    backend.subscribe((event) => events.push({
      type: event.type,
      ...(event.type === "text_delta" ? { delta: event.delta } : {}),
    }));

    const created = await backend.createSession("workspace");
    expect(created.model).toEqual({
      currentId: "gpt-5.4",
      available: [
        { id: "gpt-5.4", label: "GPT-5.4", supportsImages: true },
        { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", supportsImages: false },
      ],
    });
    expect(created.reasoning?.currentId).toBe("medium");
    expect(created.fastMode).toEqual({ enabled: false, description: "Faster responses" });
    await backend.setReasoning?.({ ...created.key, reasoningId: "high" });
    await backend.setFastMode?.({ ...created.key, enabled: true });
    const configured = await backend.sendPrompt({ ...created.key, text: "configured" });
    expect(connection.requests.findLast(({ method }) => method === "turn/start")?.params).toMatchObject({
      effort: "high",
      serviceTier: "fast",
    });
    connection.emit({
      method: "turn/completed",
      params: { threadId: created.key.sessionId, turn: { id: configured.runId, status: "completed", items: [] } },
    });
    const changed = await backend.setModel?.({ ...created.key, modelId: "gpt-5.3-codex" });
    expect(changed?.model?.currentId).toBe("gpt-5.3-codex");
    const admission = await backend.sendPrompt({ ...created.key, text: "stream" });
    expect(connection.requests.findLast(({ method }) => method === "turn/start")?.params).toMatchObject({
      model: "gpt-5.3-codex",
    });
    connection.emit({
      method: "item/agentMessage/delta",
      params: {
        threadId: created.key.sessionId,
        turnId: admission.runId,
        itemId: "message-1",
        delta: "Hello",
      },
    });
    expect(events.at(-1)).toEqual({ type: "text_delta", delta: "Hello" });
    expect((await backend.getSessionSnapshot(created.key)).messages.at(-1)?.blocks).toEqual([
      { type: "text", id: "message-1", text: "Hello" },
    ]);
    await backend.dispose();
  });

  test("accepts a different Codex build after a successful protocol initialization", async () => {
    const connection = new FakeConnection();
    connection.userAgent = "codex-cli/0.150.0";
    const backend = await createCodexBackend({ connection, scope });
    expect(connection.notifications).toEqual([{ method: "initialized", params: undefined }]);
    expect(connection.disposed).toBe(false);
    await backend.dispose();
  });

  test("projects command approval and request-user-input through backend-neutral interactions", async () => {
    const connection = new FakeConnection();
    const backend = await createCodexBackend({ connection, scope });
    const created = await backend.createSession("workspace");
    const admission = await backend.sendPrompt({ ...created.key, text: "inspect" });
    const events: Array<{ type: string; requestId?: string }> = [];
    backend.subscribe((event) => events.push({
      type: event.type,
      ...(event.type === "interaction_requested" ? { requestId: event.request.requestId } : {}),
    }));

    const approval = connection.emitRequest({
      id: 41,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: created.key.sessionId,
        turnId: admission.runId,
        itemId: "command-1",
        command: "git status",
        availableDecisions: ["accept", "acceptForSession", "decline"],
      },
    });
    await Promise.resolve();
    expect(events.at(-1)).toEqual({ type: "interaction_requested", requestId: "codex:41" });
    await backend.resolveInteraction?.({ ...created.key, requestId: "codex:41", selected: "accept" });
    expect(await approval).toEqual({ decision: "accept" });

    const question = connection.emitRequest({
      id: 42,
      method: "item/tool/requestUserInput",
      params: {
        threadId: created.key.sessionId,
        turnId: admission.runId,
        itemId: "question-1",
        questions: [{
          id: "language",
          header: "Language",
          question: "Which language?",
          isOther: true,
          isSecret: false,
          options: [{ label: "TypeScript", description: "Use TypeScript." }],
        }],
      },
    });
    await Promise.resolve();
    await backend.resolveInteraction?.({
      ...created.key,
      requestId: "codex:42",
      answers: [{ questionIndex: 0, question: "Which language?", kind: "option", answer: "TypeScript" }],
    });
    expect(await question).toEqual({ answers: { language: { answers: ["TypeScript"] } } });

    const cancelled = connection.emitRequest({
      id: 43,
      method: "item/fileChange/requestApproval",
      params: {
        threadId: created.key.sessionId,
        turnId: admission.runId,
        itemId: "file-1",
      },
    });
    await Promise.resolve();
    await backend.abortRun(admission);
    expect(await cancelled).toEqual({ decision: "cancel" });
    await backend.dispose();
  });

  test("passes product instructions and executes an owned dynamic tool", async () => {
    const connection = new FakeConnection();
    const calls: Array<{ scopeId: string; query: unknown }> = [];
    const backend = await createCodexBackend({
      connection,
      scope,
      developerInstructions: "Use Pho Code product tools only for their documented purpose.",
      dynamicTools: [{
        type: "function",
        name: "pho_search_workspace_references",
        description: "Search indexed workspace paths.",
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        async execute(call) {
          calls.push({ scopeId: call.scopeId, query: (call.arguments as { query?: unknown }).query });
          return JSON.stringify({ suggestions: [{ path: "src/index.ts", kind: "file" }], status: "ready" });
        },
      }],
    });
    const created = await backend.createSession("workspace");
    expect(connection.requests.find(({ method }) => method === "thread/start")?.params).toMatchObject({
      developerInstructions: "Use Pho Code product tools only for their documented purpose.",
      dynamicTools: [{
        type: "function",
        name: "pho_search_workspace_references",
        description: "Search indexed workspace paths.",
      }],
    });
    const admission = await backend.sendPrompt({ ...created.key, text: "find index" });
    const result = await connection.emitRequest({
      id: 50,
      method: "item/tool/call",
      params: {
        threadId: created.key.sessionId,
        turnId: admission.runId,
        callId: "call-1",
        tool: "pho_search_workspace_references",
        arguments: { query: "index" },
      },
    });
    expect(calls).toEqual([{ scopeId: "workspace", query: "index" }]);
    expect(result).toEqual({
      success: true,
      contentItems: [{
        type: "inputText",
        text: JSON.stringify({ suggestions: [{ path: "src/index.ts", kind: "file" }], status: "ready" }),
      }],
    });
    connection.emit({
      method: "item/completed",
      params: {
        threadId: created.key.sessionId,
        turnId: admission.runId,
        item: {
          type: "dynamicToolCall",
          id: "call-1",
          tool: "pho_search_workspace_references",
          arguments: { query: "index" },
          status: "completed",
          success: true,
          contentItems: [{ type: "inputText", text: "src/index.ts" }],
        },
      },
    });
    expect((await backend.getSessionSnapshot(created.key)).messages.at(-1)?.blocks).toEqual([{
      type: "tool",
      id: "call-1",
      name: "Pho Code: pho_search_workspace_references",
      kind: "other",
      status: "completed",
      input: JSON.stringify({ query: "index" }),
      output: "src/index.ts",
    }]);
    await backend.dispose();
  });
});
