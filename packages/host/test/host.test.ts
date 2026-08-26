import { describe, expect, test } from "bun:test";
import type {
  AgentRuntimeEvent,
  AgentScopeKey,
  AgentSessionSnapshot,
} from "@pho-agent/protocol";
import { createAgentHost, type AgentBackendAdapter } from "../src";

function fakeBackend(id: string): AgentBackendAdapter {
  const listeners = new Set<(event: AgentRuntimeEvent) => void>();
  const snapshots = new Map<string, AgentSessionSnapshot>();
  const read = (key: AgentScopeKey) => snapshots.get(key.sessionId) ?? {
    key,
    run: { status: "idle" as const },
    messages: [],
  };
  return {
    descriptor: { id, label: id.toUpperCase(), capabilities: { steering: "native", approvals: "native" } },
    getSessionSnapshot: async (key) => read(key),
    async createSession(scopeId) {
      const value = read({ scopeId, sessionId: `${id}-session` });
      snapshots.set(value.key.sessionId, value);
      for (const listener of listeners) {
        listener({ ...value.key, type: "session_snapshot", occurredAt: "2026-08-26T00:00:00.000Z", snapshot: value });
      }
      return value;
    },
    openSession: async (key) => read(key),
    sendPrompt: async (input) => ({ ...input, runId: `${id}-run`, admitted: true }),
    steerRun: async (input) => ({ ...input, admitted: true }),
    queueFollowUp: async (input) => ({ ...input, admitted: true }),
    abortRun: async () => undefined,
    resolveInteraction: async () => undefined,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: async () => undefined,
  };
}

describe("agent host", () => {
  test("routes sessions and events by backend identity", async () => {
    const host = createAgentHost([fakeBackend("pi"), fakeBackend("codex")]);
    const events: Array<{ backendId: string; snapshotBackendId?: string }> = [];
    host.subscribe((event) => events.push({
      backendId: event.backendId,
      ...(event.type === "session_snapshot" ? { snapshotBackendId: event.snapshot.key.backendId } : {}),
    }));
    const created = await host.createSession({ backendId: "codex", scopeId: "workspace" });
    expect(created.key).toEqual({ backendId: "codex", scopeId: "workspace", sessionId: "codex-session" });
    expect(events).toEqual([{ backendId: "codex", snapshotBackendId: "codex" }]);
    expect((await host.sendPrompt({ ...created.key, text: "hello" })).backendId).toBe("codex");
    await host.resolveInteraction({ ...created.key, requestId: "request-1", selected: "accept" });
    await host.dispose();
  });

  test("rejects duplicate and unknown backends", async () => {
    expect(() => createAgentHost([fakeBackend("pi"), fakeBackend(" pi ")])).toThrow("Duplicate");
    const host = createAgentHost([fakeBackend("pi")]);
    await expect(host.createSession({ backendId: "codex", scopeId: "workspace" })).rejects.toThrow("Unknown");
    await host.dispose();
  });

  test("rejects an operation omitted by a backend", async () => {
    const backend = fakeBackend("codex");
    backend.queueFollowUp = undefined;
    const host = createAgentHost([backend]);
    await expect(host.queueFollowUp({
      backendId: "codex",
      scopeId: "workspace",
      sessionId: "session",
      runId: "run",
      text: "later",
    })).rejects.toThrow("does not support queueFollowUp");
    await host.dispose();
  });
});
