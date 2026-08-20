import { describe, expect, test } from "bun:test";
import {
  MAX_AGENT_ID_LENGTH,
  agentScopeKeyId,
  normalizeAgentScopeKey,
} from "../src";

describe("agent scope identity", () => {
  test("normalizes opaque scope and session ids without path interpretation", () => {
    const key = normalizeAgentScopeKey({ scopeId: " memory:alpha ", sessionId: " session-1 " });
    expect(key).toEqual({ scopeId: "memory:alpha", sessionId: "session-1" });
    expect(agentScopeKeyId(key)).toBe('["memory:alpha","session-1"]');
  });

  test("rejects empty and oversized ids", () => {
    expect(() => normalizeAgentScopeKey({ scopeId: " ", sessionId: "ok" })).toThrow();
    expect(() =>
      normalizeAgentScopeKey({ scopeId: "ok", sessionId: "x".repeat(MAX_AGENT_ID_LENGTH + 1) }),
    ).toThrow();
  });
});
