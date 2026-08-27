import { describe, expect, test } from "bun:test";
import type {
  InitializeResponse,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import type { AgentRuntimeEvent } from "@pho-agent/protocol";
import type { AcpClient } from "../src";
import { createAcpBackend } from "../src";

class FakeAcpClient implements AcpClient {
  readonly listeners = new Set<(notification: SessionNotification) => void>();
  readonly opened: Array<{ sessionId: string; cwd: string }> = [];
  cancelled?: string;
  disposed = false;
  finishPrompt?: (response: PromptResponse) => void;
  permissionHandler?: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
  configOptions: SessionConfigOption[] = [modelConfig("claude-sonnet"), reasoningConfig("medium"), fastConfig("off")];

  async initialize(): Promise<InitializeResponse> {
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true },
        mcpCapabilities: { http: true, sse: false },
        sessionCapabilities: { fork: {}, resume: {} },
      },
    };
  }

  async createSession() {
    return { sessionId: "acp-session", configOptions: this.configOptions };
  }

  async openSession(sessionId: string, cwd: string): Promise<SessionConfigOption[]> {
    this.opened.push({ sessionId, cwd });
    return this.configOptions;
  }

  async setSessionConfigOption(
    _sessionId: string,
    configId: string,
    value: string,
  ): Promise<SessionConfigOption[]> {
    this.configOptions = this.configOptions.map((option) => {
      if (option.id !== configId) return option;
      if (configId === "model") return modelConfig(value);
      if (configId === "effort") return reasoningConfig(value);
      if (configId === "fast") return fastConfig(value);
      throw new Error("Unknown config option.");
    });
    return this.configOptions;
  }

  prompt(): Promise<PromptResponse> {
    return new Promise((resolve) => {
      this.finishPrompt = resolve;
    });
  }

  async cancel(sessionId: string): Promise<void> {
    this.cancelled = sessionId;
  }

  setPermissionHandler(
    handler: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>,
  ): () => void {
    this.permissionHandler = handler;
    return () => {
      if (this.permissionHandler === handler) this.permissionHandler = undefined;
    };
  }

  requestPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (!this.permissionHandler) throw new Error("No permission handler is registered.");
    return this.permissionHandler(request);
  }

  subscribe(listener: (notification: SessionNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(notification: SessionNotification): void {
    for (const listener of this.listeners) listener(notification);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

describe("ACP backend adapter", () => {
  test("fails cleanly when the external ACP command is missing", async () => {
    await expect(createAcpBackend({
      id: "missing-acp",
      label: "Missing",
      command: "pho-agent-definitely-missing-acp",
      scope: { resolve: () => ({ runtimeDirectory: "/tmp/acp-workspace" }) },
    })).rejects.toThrow("ACP agent failed to start");
  });

  test("negotiates capabilities and projects prompt updates", async () => {
    const client = new FakeAcpClient();
    const backend = await createAcpBackend({
      id: "claude-acp",
      label: "Claude",
      client,
      scope: { resolve: () => ({ runtimeDirectory: "/tmp/acp-workspace" }) },
    });
    expect(backend.descriptor).toEqual({
      id: "claude-acp",
      label: "Claude",
      capabilities: {
        plans: "experimental",
        approvals: "native",
        "model-selection": "experimental",
        "reasoning-selection": "experimental",
        "fast-mode": "experimental",
        images: "native",
        mcp: "native",
        "session-forking": "experimental",
      },
    });

    const events: AgentRuntimeEvent[] = [];
    backend.subscribe((event) => events.push(event));
    const created = await backend.createSession("workspace");
    expect(created.model).toEqual({
      currentId: "claude-sonnet",
      available: [
        { id: "claude-sonnet", label: "Sonnet" },
        { id: "claude-opus", label: "Opus" },
      ],
    });
    expect((await backend.setModel?.({ ...created.key, modelId: "claude-opus" }))?.model?.currentId).toBe("claude-opus");
    expect(created.reasoning?.currentId).toBe("medium");
    expect(created.fastMode?.enabled).toBe(false);
    expect((await backend.setReasoning?.({ ...created.key, reasoningId: "high" }))?.reasoning?.currentId).toBe("high");
    expect((await backend.setFastMode?.({ ...created.key, enabled: true }))?.fastMode?.enabled).toBe(true);
    const admission = await backend.sendPrompt({ ...created.key, text: "inspect" });
    client.emit({
      sessionId: created.key.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Run tests",
        name: "shell",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "bun test" },
      },
    });
    expect(events.at(-1)).toMatchObject({ type: "tool_update", runId: admission.runId });
    client.emit({
      sessionId: created.key.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        _meta: { terminal_output: { terminal_id: "tool-1", data: "tests passed\n" } },
      },
    });
    expect(events.at(-1)).toMatchObject({
      type: "tool_update",
      tool: { id: "tool-1", output: "tests passed\n" },
    });
    client.emit({
      sessionId: created.key.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "message-1",
        content: { type: "text", text: "Done." },
      },
    });
    expect(events.at(-1)).toMatchObject({ type: "text_delta", runId: admission.runId, delta: "Done." });
    client.finishPrompt?.({ stopReason: "end_turn" });
    await Promise.resolve();

    const snapshot = await backend.getSessionSnapshot(created.key);
    expect(snapshot.run).toEqual({ status: "settled", runId: admission.runId });
    expect(snapshot.messages[1]?.blocks).toEqual([
      {
        type: "tool",
        id: "tool-1",
        name: "shell",
        title: "Run tests",
        kind: "command",
        status: "running",
        input: '{"command":"bun test"}',
        output: "tests passed\n",
      },
      { type: "text", id: "message-1", text: "Done." },
    ]);
    await backend.dispose();
    expect(client.disposed).toBe(true);
  });

  test("cancels the backend-native session run", async () => {
    const client = new FakeAcpClient();
    const backend = await createAcpBackend({
      id: "agent",
      label: "Agent",
      client,
      scope: { resolve: () => ({ runtimeDirectory: "/tmp/acp-workspace" }) },
    });
    const created = await backend.createSession("workspace");
    const admission = await backend.sendPrompt({ ...created.key, text: "wait" });
    await backend.abortRun(admission);
    expect(client.cancelled).toBe("acp-session");
    await backend.dispose();
  });

  test("projects negotiated permission options and returns the selected ACP option id", async () => {
    const client = new FakeAcpClient();
    const backend = await createAcpBackend({
      id: "agent",
      label: "Agent",
      client,
      scope: { resolve: () => ({ runtimeDirectory: "/tmp/acp-workspace" }) },
    });
    const created = await backend.createSession("workspace");
    const admission = await backend.sendPrompt({ ...created.key, text: "inspect" });
    let requestId = "";
    backend.subscribe((event) => {
      if (event.type === "interaction_requested") requestId = event.request.requestId;
    });
    const response = client.requestPermission({
      sessionId: created.key.sessionId,
      toolCall: {
        toolCallId: "tool-1",
        title: "Run tests",
        name: "shell",
        kind: "execute",
        rawInput: { command: "bun test" },
      },
      options: [
        { optionId: "once", name: "Allow once", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    });
    await Promise.resolve();
    expect(requestId).toStartWith("acp:");
    await backend.resolveInteraction?.({ ...created.key, requestId, selected: "once" });
    expect(await response).toEqual({ outcome: { outcome: "selected", optionId: "once" } });

    const cancelled = client.requestPermission({
      sessionId: created.key.sessionId,
      toolCall: { toolCallId: "tool-2", title: "Wait" },
      options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }],
    });
    await Promise.resolve();
    await backend.abortRun(admission);
    expect(await cancelled).toEqual({ outcome: { outcome: "cancelled" } });
    await backend.dispose();
  });
});

function modelConfig(currentValue: string): SessionConfigOption {
  return {
    type: "select",
    id: "model",
    name: "Model",
    category: "model",
    currentValue,
    options: [
      { value: "claude-sonnet", name: "Sonnet" },
      { value: "claude-opus", name: "Opus" },
    ],
  };
}

function reasoningConfig(currentValue: string): SessionConfigOption {
  return {
    type: "select",
    id: "effort",
    name: "Reasoning",
    category: "thought_level",
    currentValue,
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
    ],
  };
}

function fastConfig(currentValue: string): SessionConfigOption {
  return {
    type: "select",
    id: "fast",
    name: "Fast mode",
    description: "Faster responses",
    category: "model_config",
    currentValue,
    options: [
      { value: "on", name: "On" },
      { value: "off", name: "Off" },
    ],
  };
}
