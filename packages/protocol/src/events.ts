import type { AgentScopeKey } from "./identity";
import type { AgentInteractionRequest } from "./interaction";
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
    })
  | (AgentScopeKey & {
      type: "interaction_requested";
      occurredAt: string;
      runId: string;
      request: AgentInteractionRequest;
    })
  | (AgentScopeKey & {
      type: "interaction_settled";
      occurredAt: string;
      runId: string;
      requestId: string;
    });

export type Unsubscribe = () => void;
