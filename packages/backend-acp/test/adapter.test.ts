import { describe, expect, test } from "bun:test";
import type {
  InitializeResponse,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import type { AcpClient } from "../src";
import { createAcpBackend } from "../src";

class FakeAcpClient implements AcpClient {
  readonly listeners = new Set<(notification: SessionNotification) => void>();
  readonly opened: Array<{ sessionId: string; cwd: string }> = [];
  cancelled?: string;
  disposed = false;
  finishPrompt?: (response: PromptResponse) => void;
  permissionHandler?: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;

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

  async createSession(): Promise<string> {
    return "acp-session";
  }

  async openSession(sessionId: string, cwd: string): Promise<void> {
    this.opened.push({ sessionId, cwd });
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
        images: "native",
        mcp: "native",
        "session-forking": "experimental",
      },
    });

    const created = await backend.createSession("workspace");
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
    client.emit({
      sessionId: created.key.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "message-1",
        content: { type: "text", text: "Done." },
      },
    });
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
