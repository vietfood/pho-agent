import { describe, expect, test } from "bun:test";
import {
  agentBackendScopeKeyId,
  normalizeAgentBackendDescriptor,
  normalizeAgentBackendScopeKey,
} from "../src";

describe("agent backend identity", () => {
  test("normalizes the backend as part of session ownership", () => {
    const key = normalizeAgentBackendScopeKey({
      backendId: " codex ",
      scopeId: " memory:alpha ",
      sessionId: " session-1 ",
    });
    expect(key).toEqual({ backendId: "codex", scopeId: "memory:alpha", sessionId: "session-1" });
    expect(agentBackendScopeKeyId(key)).toBe('["codex","memory:alpha","session-1"]');
  });

  test("normalizes descriptors and rejects unknown capabilities", () => {
    expect(normalizeAgentBackendDescriptor({
      id: " pi ",
      label: " Pi ",
      capabilities: { steering: "native", plans: "experimental" },
    })).toEqual({
      id: "pi",
      label: "Pi",
      capabilities: { steering: "native", plans: "experimental" },
    });
    expect(() => normalizeAgentBackendDescriptor({
      id: "pi",
      label: "Pi",
      capabilities: { unknown: "native" } as never,
    })).toThrow("unknown capability");
    expect(() => normalizeAgentBackendDescriptor({
      id: "pi",
      label: "Pi",
      capabilities: { steering: "partial" } as never,
    })).toThrow("unknown support level");
  });
});
