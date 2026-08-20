export const MAX_AGENT_ID_LENGTH = 1_024;

export interface AgentScopeKey {
  scopeId: string;
  sessionId: string;
}

export function requireAgentId(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string.`);
  }
  const id = value.trim();
  if (id.length === 0 || id.length > MAX_AGENT_ID_LENGTH) {
    throw new TypeError(`${label} must contain 1-${MAX_AGENT_ID_LENGTH} characters.`);
  }
  return id;
}

export function normalizeAgentScopeKey(value: AgentScopeKey): AgentScopeKey {
  return {
    scopeId: requireAgentId(value.scopeId, "scopeId"),
    sessionId: requireAgentId(value.sessionId, "sessionId"),
  };
}

export function agentScopeKeyId(value: AgentScopeKey): string {
  const key = normalizeAgentScopeKey(value);
  return JSON.stringify([key.scopeId, key.sessionId]);
}
