import {
  normalizeAgentScopeKey,
  requireAgentId,
  type AgentScopeKey,
} from "./identity";
import type {
  AgentPromptAdmission,
  AgentQueueAdmission,
  AgentSetModelInput,
  AgentSetFastModeInput,
  AgentSetReasoningInput,
  AgentSessionSnapshot,
  AgentToolBlock,
} from "./session";
import type { AgentInteractionRequest, AgentInteractionResolution } from "./interaction";

export const AGENT_BACKEND_CAPABILITIES = [
  "model-selection",
  "reasoning-selection",
  "fast-mode",
  "steering",
  "queued-follow-up",
  "images",
  "approvals",
  "manual-compaction",
  "session-forking",
  "plans",
  "goals",
  "native-review",
  "subagents",
  "skills",
  "mcp",
  "dynamic-tools",
  "structured-file-changes",
] as const;

export type AgentBackendCapability = (typeof AGENT_BACKEND_CAPABILITIES)[number];
export type AgentBackendSupport = "native" | "emulated" | "experimental";

export interface AgentBackendDescriptor {
  id: string;
  label: string;
  capabilities: Partial<Record<AgentBackendCapability, AgentBackendSupport>>;
}

export interface AgentBackendScope {
  backendId: string;
  scopeId: string;
}

export interface AgentBackendScopeKey extends AgentBackendScope {
  sessionId: string;
}

export type AgentBackendSessionSnapshot = Omit<AgentSessionSnapshot, "key"> & {
  key: AgentBackendScopeKey;
};

export interface AgentBackendPromptInput extends AgentBackendScopeKey {
  text: string;
}

export interface AgentBackendSteerInput extends AgentBackendPromptInput {
  runId: string;
}

export type AgentBackendFollowUpInput = AgentBackendSteerInput;

export interface AgentBackendAbortInput extends AgentBackendScopeKey {
  runId: string;
}

export type AgentBackendSetModelInput = Omit<AgentSetModelInput, keyof AgentScopeKey> &
  AgentBackendScopeKey;

export type AgentBackendSetReasoningInput = Omit<AgentSetReasoningInput, keyof AgentScopeKey> &
  AgentBackendScopeKey;

export type AgentBackendSetFastModeInput = Omit<AgentSetFastModeInput, keyof AgentScopeKey> &
  AgentBackendScopeKey;

export type AgentBackendInteractionResolution = AgentBackendScopeKey & AgentInteractionResolution;

export type AgentBackendPromptAdmission = Omit<AgentPromptAdmission, keyof AgentScopeKey> &
  AgentBackendScopeKey;

export type AgentBackendQueueAdmission = Omit<AgentQueueAdmission, keyof AgentScopeKey> &
  AgentBackendScopeKey;

export type AgentBackendEvent =
  | (AgentBackendScopeKey & {
      type: "session_snapshot";
      occurredAt: string;
      snapshot: AgentBackendSessionSnapshot;
    })
  | (AgentBackendScopeKey & {
      type: "text_delta";
      occurredAt: string;
      runId: string;
      delta: string;
    })
  | (AgentBackendScopeKey & {
      type: "tool_update";
      occurredAt: string;
      runId: string;
      tool: AgentToolBlock;
    })
  | (AgentBackendScopeKey & {
      type: "run_started" | "run_settled" | "run_cancelled";
      occurredAt: string;
      runId: string;
    })
  | (AgentBackendScopeKey & {
      type: "run_failed";
      occurredAt: string;
      runId: string;
      error: string;
    })
  | (AgentBackendScopeKey & {
      type: "interaction_requested";
      occurredAt: string;
      runId: string;
      request: AgentInteractionRequest;
    })
  | (AgentBackendScopeKey & {
      type: "interaction_settled";
      occurredAt: string;
      runId: string;
      requestId: string;
    });

export function normalizeAgentBackendDescriptor(
  value: AgentBackendDescriptor,
): AgentBackendDescriptor {
  const capabilities: AgentBackendDescriptor["capabilities"] = {};
  for (const [capability, support] of Object.entries(value.capabilities)) {
    if (!AGENT_BACKEND_CAPABILITIES.includes(capability as AgentBackendCapability)) {
      throw new TypeError("The backend descriptor contains an unknown capability.");
    }
    if (support !== "native" && support !== "emulated" && support !== "experimental") {
      throw new TypeError("The backend descriptor contains an unknown support level.");
    }
    capabilities[capability as AgentBackendCapability] = support;
  }
  return {
    id: requireAgentId(value.id, "backendId"),
    label: requireAgentId(value.label, "backend label"),
    capabilities,
  };
}

export function normalizeAgentBackendScope(value: AgentBackendScope): AgentBackendScope {
  return {
    backendId: requireAgentId(value.backendId, "backendId"),
    scopeId: requireAgentId(value.scopeId, "scopeId"),
  };
}

export function normalizeAgentBackendScopeKey(
  value: AgentBackendScopeKey,
): AgentBackendScopeKey {
  return {
    backendId: requireAgentId(value.backendId, "backendId"),
    ...normalizeAgentScopeKey(value),
  };
}

export function agentBackendScopeKeyId(value: AgentBackendScopeKey): string {
  const key = normalizeAgentBackendScopeKey(value);
  return JSON.stringify([key.backendId, key.scopeId, key.sessionId]);
}
