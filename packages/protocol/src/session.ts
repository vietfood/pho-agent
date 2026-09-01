import type { AgentApprovalSessionState } from "./approval";
import type { AgentScopeKey } from "./identity";

export type AgentRunStatus = "idle" | "running" | "settled" | "failed" | "cancelled";

export interface AgentTextBlock {
  type: "text";
  id?: string;
  text: string;
}

export type AgentToolKind =
  | "command"
  | "file-change"
  | "mcp"
  | "web-search"
  | "image"
  | "review"
  | "subagent"
  | "other";

export interface AgentToolBlock {
  type: "tool";
  id: string;
  name: string;
  kind?: AgentToolKind;
  status: "running" | "completed" | "failed";
  title?: string;
  input?: string;
  output?: string;
}

export type AgentTranscriptBlock = AgentTextBlock | AgentToolBlock;

export interface AgentTranscriptMessage {
  id: string;
  role: "user" | "assistant";
  blocks: AgentTranscriptBlock[];
}

export interface AgentModelOption {
  id: string;
  label: string;
  description?: string;
  supportsImages?: boolean;
}

export interface AgentModelState {
  available: AgentModelOption[];
  currentId?: string;
}

export interface AgentReasoningOption {
  id: string;
  label: string;
  description?: string;
}

export interface AgentReasoningState {
  available: AgentReasoningOption[];
  currentId?: string;
}

export interface AgentFastModeState {
  enabled: boolean;
  description?: string;
}

export interface AgentSessionSnapshot {
  key: AgentScopeKey;
  run: {
    status: AgentRunStatus;
    runId?: string;
    error?: string;
  };
  messages: AgentTranscriptMessage[];
  model?: AgentModelState;
  reasoning?: AgentReasoningState;
  fastMode?: AgentFastModeState;
  approval?: AgentApprovalSessionState;
}

export interface AgentSetModelInput extends AgentScopeKey {
  modelId: string;
}

export interface AgentSetReasoningInput extends AgentScopeKey {
  reasoningId: string;
}

export interface AgentSetFastModeInput extends AgentScopeKey {
  enabled: boolean;
}

export interface AgentPromptInput extends AgentScopeKey {
  text: string;
}

export interface AgentSteerInput extends AgentScopeKey {
  runId: string;
  text: string;
}

export type AgentFollowUpInput = AgentSteerInput;

export interface AgentAbortInput extends AgentScopeKey {
  runId: string;
}

export interface AgentPromptAdmission extends AgentScopeKey {
  runId: string;
  admitted: true;
}

export type AgentQueueAdmission = AgentPromptAdmission;
