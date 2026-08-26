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

export interface AgentSessionSnapshot {
  key: AgentScopeKey;
  run: {
    status: AgentRunStatus;
    runId?: string;
    error?: string;
  };
  messages: AgentTranscriptMessage[];
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
