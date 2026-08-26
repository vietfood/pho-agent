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
}

export interface CodexTurn {
  id: string;
  status: string;
  items: CodexThreadItem[];
  error?: { message?: string } | null;
}

export interface CodexThread {
  id: string;
  turns?: CodexTurn[];
}

export interface CodexThreadResponse {
  thread: CodexThread;
}

export interface CodexTurnResponse {
  turn: CodexTurn;
}
