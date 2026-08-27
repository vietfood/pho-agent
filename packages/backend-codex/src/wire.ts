export interface CodexThreadItem {
  type: string;
  id?: string;
  clientId?: string | null;
  text?: string;
  content?: unknown[];
  command?: string;
  cwd?: string;
  status?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  changes?: unknown[];
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
  query?: string;
  results?: unknown[] | null;
  path?: string;
  review?: string;
  prompt?: string | null;
  receiverThreadIds?: string[];
  contentItems?: unknown[] | null;
  success?: boolean | null;
}

export interface CodexDynamicToolSpec {
  type: "function";
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface CodexDynamicToolCallParams {
  arguments: unknown;
  callId: string;
  namespace?: string | null;
  threadId: string;
  tool: string;
  turnId: string;
}

export interface CodexTurn {
  id: string;
  status: string;
  items: CodexThreadItem[];
  error?: { message?: string } | null;
}

export interface CodexThread {
  id: string;
  model?: string;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
  turns?: CodexTurn[];
}

export interface CodexReasoningEffort {
  reasoningEffort: string;
  description?: string;
}

export interface CodexServiceTier {
  id: string;
  name?: string;
  description?: string;
}

export interface CodexModel {
  id: string;
  model?: string;
  displayName?: string;
  description?: string;
  inputModalities?: string[];
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: CodexReasoningEffort[];
  defaultServiceTier?: string | null;
  serviceTiers?: CodexServiceTier[];
}

export interface CodexModelListResponse {
  data: CodexModel[];
  nextCursor?: string | null;
}

export interface CodexThreadResponse {
  thread: CodexThread;
}

export interface CodexTurnResponse {
  turn: CodexTurn;
}
