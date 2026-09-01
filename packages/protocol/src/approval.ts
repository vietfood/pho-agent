export const AGENT_APPROVAL_MODES = ["ask", "auto", "full"] as const;
export type AgentApprovalMode = (typeof AGENT_APPROVAL_MODES)[number];

export const AGENT_APPROVAL_DECISION_OUTCOMES = [
  "allow-once",
  "allow-session",
  "deny",
  "require-owner",
  "unavailable",
] as const;
export type AgentApprovalDecisionOutcome = (typeof AGENT_APPROVAL_DECISION_OUTCOMES)[number];

export const AGENT_APPROVAL_REVIEWER_STATES = [
  "user",
  "idle",
  "reviewing",
  "owner-required",
  "unavailable",
  "none",
] as const;
export type AgentApprovalReviewerState = (typeof AGENT_APPROVAL_REVIEWER_STATES)[number];

export const AGENT_APPROVAL_MAX_ID_CHARS = 200;
export const AGENT_APPROVAL_MAX_RATIONALE_CHARS = 1_000;
export const AGENT_APPROVAL_MAX_SUMMARY_CHARS = 2_000;
export const AGENT_APPROVAL_MAX_INPUT_BYTES = 128 * 1024;

export interface AgentApprovalDecision {
  outcome: AgentApprovalDecisionOutcome;
  rationale?: string;
}

export interface AgentApprovalSessionState {
  mode: AgentApprovalMode;
  reviewerState: AgentApprovalReviewerState;
  policyGeneration: number;
  activeGrantCount: number;
  circuitOpen: boolean;
}

export function isAgentApprovalMode(value: unknown): value is AgentApprovalMode {
  return value === "ask" || value === "auto" || value === "full";
}

export function isAgentApprovalDecision(
  value: unknown,
  options: { allowSession?: boolean } = {},
): value is AgentApprovalDecision {
  if (!isPlainRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "outcome" && key !== "rationale")) {
    return false;
  }
  if (!AGENT_APPROVAL_DECISION_OUTCOMES.includes(value.outcome as AgentApprovalDecisionOutcome)) {
    return false;
  }
  if (value.outcome === "allow-session" && options.allowSession !== true) {
    return false;
  }
  return (
    value.rationale === undefined ||
    (typeof value.rationale === "string" && value.rationale.length <= AGENT_APPROVAL_MAX_RATIONALE_CHARS)
  );
}

export function isAgentApprovalSessionState(value: unknown): value is AgentApprovalSessionState {
  if (!isPlainRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (
    keys.some(
      (key) =>
        key !== "mode" &&
        key !== "reviewerState" &&
        key !== "policyGeneration" &&
        key !== "activeGrantCount" &&
        key !== "circuitOpen",
    )
  ) {
    return false;
  }
  return (
    isAgentApprovalMode(value.mode) &&
    AGENT_APPROVAL_REVIEWER_STATES.includes(value.reviewerState as AgentApprovalReviewerState) &&
    Number.isSafeInteger(value.policyGeneration) &&
    (value.policyGeneration as number) >= 0 &&
    Number.isSafeInteger(value.activeGrantCount) &&
    (value.activeGrantCount as number) >= 0 &&
    typeof value.circuitOpen === "boolean"
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
