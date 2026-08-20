import type { AgentScopeKey } from "./identity";
import type { AgentSessionSnapshot } from "./session";

export type AgentRuntimeEvent =
  | (AgentScopeKey & {
      type: "session_snapshot";
      occurredAt: string;
      snapshot: AgentSessionSnapshot;
    })
  | (AgentScopeKey & {
      type: "run_started" | "run_settled" | "run_cancelled";
      occurredAt: string;
      runId: string;
    })
  | (AgentScopeKey & {
      type: "run_failed";
      occurredAt: string;
      runId: string;
      error: string;
    });

export type Unsubscribe = () => void;
