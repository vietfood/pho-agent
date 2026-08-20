import type { AgentScopeKey } from "./identity";

export type AgentRunStatus = "idle" | "running" | "settled" | "failed" | "cancelled";

export interface AgentTextBlock {
  type: "text";
  text: string;
}

export interface AgentToolBlock {
  type: "tool";
  id: string;
  name: string;
  status: "running" | "completed" | "failed";
  text?: string;
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
