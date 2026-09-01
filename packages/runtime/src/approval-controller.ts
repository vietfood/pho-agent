import { createHash } from "node:crypto";
import {
  AGENT_APPROVAL_MAX_ID_CHARS,
  AGENT_APPROVAL_MAX_INPUT_BYTES,
  AGENT_APPROVAL_MAX_RATIONALE_CHARS,
  AGENT_APPROVAL_MAX_SUMMARY_CHARS,
  isAgentApprovalDecision,
  isAgentApprovalMode,
  isJsonSafeValue,
  type AgentApprovalDecision,
  type AgentApprovalMode,
  type AgentApprovalReviewerState,
  type AgentApprovalSessionState,
  type AgentScopeKey,
} from "@pho-agent/protocol";

export type ApprovalJsonValue =
  | null
  | boolean
  | number
  | string
  | ApprovalJsonValue[]
  | { [key: string]: ApprovalJsonValue };

export interface FrozenApprovalInput {
  canonical: string;
  fingerprint: string;
  value: ApprovalJsonValue;
}

export interface ApprovalActionRequest extends AgentScopeKey {
  runId: string;
  requestId: string;
  toolName: string;
  input: unknown;
  summary?: string;
  grantKey?: string;
  context?: unknown;
}

export interface FrozenApprovalAction extends Omit<ApprovalActionRequest, "input" | "context"> {
  input: ApprovalJsonValue;
  inputCanonical: string;
  inputFingerprint: string;
  context?: ApprovalJsonValue;
}

export type ApprovalPolicyOutcome = "allow" | "review" | "require-owner" | "deny";

export interface ApprovalPolicyDecision {
  outcome: ApprovalPolicyOutcome;
  ruleId: string;
  rationale?: string;
}

export interface ApprovalPolicyEvaluation {
  invariantDeny?: ApprovalPolicyDecision & { outcome: "deny" };
  project?: ApprovalPolicyDecision;
  boundary: ApprovalPolicyDecision;
}

export type ApprovalPolicy = (
  action: FrozenApprovalAction,
) => ApprovalPolicyEvaluation | Promise<ApprovalPolicyEvaluation>;

export interface ApprovalReviewRequest {
  action: FrozenApprovalAction;
  mode: AgentApprovalMode;
  policy: ApprovalPolicyDecision;
  ownerRetry: boolean;
}

export type ApprovalResolver = (
  request: ApprovalReviewRequest,
  signal: AbortSignal,
) => unknown | Promise<unknown>;

export type ApprovalDecisionSource = "policy" | "session-grant" | "owner" | "reviewer";
export type ApprovalGrantScope = "once" | "session";
export type ApprovalRefusalOutcome =
  | "deny"
  | "require-owner"
  | "unavailable"
  | "cancelled"
  | "stale"
  | "circuit-open";

export type ApprovalAuthorizationResult =
  | {
      authorized: true;
      authorizationId: string;
      fingerprint: string;
      source: ApprovalDecisionSource;
      grantScope: ApprovalGrantScope;
    }
  | {
      authorized: false;
      outcome: ApprovalRefusalOutcome;
      rationale?: string;
      circuitOpen: boolean;
    };

export interface ApprovalDecisionRecord extends AgentScopeKey {
  runId: string;
  requestId: string;
  toolName: string;
  mode: AgentApprovalMode;
  source: ApprovalDecisionSource;
  outcome: AgentApprovalDecision["outcome"] | ApprovalRefusalOutcome;
  fingerprint: string;
  policyRuleId: string;
  rationale?: string;
  occurredAt: string;
}

export interface ApprovalControllerOptions {
  key: AgentScopeKey;
  mode?: AgentApprovalMode;
  policy: ApprovalPolicy;
  ownerResolver?: ApprovalResolver;
  autoReviewer?: ApprovalResolver;
  onDecision?: (record: ApprovalDecisionRecord) => void | Promise<void>;
  now?: () => Date;
}

interface DispatchAuthorization {
  fingerprint: string;
  policyGeneration: number;
  runId: string;
}

interface RecentAutoDenial {
  fingerprint: string;
  policyGeneration: number;
  runId: string;
  toolName: string;
}

const AUTOMATIC_DENIAL_CIRCUIT_RATIONALE =
  "Automatic approval stopped after repeated denials.";

const POLICY_STRENGTH: Record<ApprovalPolicyOutcome, number> = {
  allow: 0,
  review: 1,
  "require-owner": 2,
  deny: 3,
};

export function canonicalizeApprovalInput(input: unknown): string {
  if (!isJsonSafeValue(input)) {
    throw new TypeError("Approval input must be a plain JSON-safe value.");
  }
  const canonical = canonicalJson(input as ApprovalJsonValue);
  if (Buffer.byteLength(canonical, "utf8") > AGENT_APPROVAL_MAX_INPUT_BYTES) {
    throw new TypeError(`Approval input exceeds ${AGENT_APPROVAL_MAX_INPUT_BYTES} bytes.`);
  }
  return canonical;
}

export function fingerprintApprovalInput(input: unknown): string {
  return createHash("sha256").update(canonicalizeApprovalInput(input)).digest("hex");
}

export function freezeApprovalInput(input: unknown): FrozenApprovalInput {
  const canonical = canonicalizeApprovalInput(input);
  return {
    canonical,
    fingerprint: createHash("sha256").update(canonical).digest("hex"),
    value: JSON.parse(canonical) as ApprovalJsonValue,
  };
}

export class ApprovalController {
  private readonly key: AgentScopeKey;
  private mode: AgentApprovalMode;
  private policy: ApprovalPolicy;
  private readonly ownerResolver?: ApprovalResolver;
  private readonly autoReviewer?: ApprovalResolver;
  private readonly onDecision?: ApprovalControllerOptions["onDecision"];
  private readonly now: () => Date;
  private currentRunId?: string;
  private generation = 0;
  private reviewerState: AgentApprovalReviewerState;
  private disposed = false;
  private authorizationSequence = 0;
  private consecutiveAutoDenials = 0;
  private circuitOpen = false;
  private autoDecisionWindow: boolean[] = [];
  private readonly pending = new Map<string, AbortController>();
  private readonly seenRequests = new Set<string>();
  private readonly dispatchAuthorizations = new Map<string, DispatchAuthorization>();
  private readonly sessionGrants = new Set<string>();
  private readonly recentAutoDenials = new Map<string, RecentAutoDenial>();
  private retryMarker?: RecentAutoDenial;
  private activeAutoRequestId?: string;

  constructor(options: ApprovalControllerOptions) {
    this.key = requireScopeKey(options.key);
    this.mode = options.mode ?? "ask";
    if (!isAgentApprovalMode(this.mode)) {
      throw new TypeError("Unknown approval mode.");
    }
    this.policy = options.policy;
    this.ownerResolver = options.ownerResolver;
    this.autoReviewer = options.autoReviewer;
    this.onDecision = options.onDecision;
    this.now = options.now ?? (() => new Date());
    this.reviewerState = reviewerStateForMode(this.mode);
  }

  activeRunId(): string | undefined {
    return this.currentRunId;
  }

  scopeKey(): AgentScopeKey {
    return { ...this.key };
  }

  snapshot(): AgentApprovalSessionState {
    return {
      mode: this.mode,
      reviewerState: this.reviewerState,
      policyGeneration: this.generation,
      activeGrantCount: this.sessionGrants.size,
      circuitOpen: this.circuitOpen,
    };
  }

  beginRun(runId: string): void {
    this.assertUsable();
    requireId(runId, "runId");
    if (this.currentRunId && this.currentRunId !== runId) {
      throw new Error("Another approval run is already active.");
    }
    if (this.currentRunId === runId) {
      return;
    }
    this.currentRunId = runId;
    this.resetTurnState();
  }

  endRun(runId: string): void {
    this.assertUsable();
    if (this.currentRunId !== runId) {
      throw new Error("Cannot end a stale approval run.");
    }
    this.cancelPending();
    for (const [id, authorization] of this.dispatchAuthorizations) {
      if (authorization.runId === runId) {
        this.dispatchAuthorizations.delete(id);
      }
    }
    this.currentRunId = undefined;
    this.resetTurnState();
    this.reviewerState = reviewerStateForMode(this.mode);
  }

  setMode(mode: AgentApprovalMode): void {
    this.assertIdle();
    if (!isAgentApprovalMode(mode)) {
      throw new TypeError("Unknown approval mode.");
    }
    if (mode === this.mode) {
      return;
    }
    this.mode = mode;
    this.advancePolicyGeneration();
    this.reviewerState = reviewerStateForMode(mode);
  }

  replacePolicy(policy: ApprovalPolicy): void {
    this.assertIdle();
    this.policy = policy;
    this.advancePolicyGeneration();
  }

  revokeSessionGrant(grantKey: string): boolean {
    this.assertUsable();
    const key = requireId(grantKey, "grantKey");
    return this.sessionGrants.delete(key);
  }

  revokeAll(): void {
    this.assertUsable();
    this.sessionGrants.clear();
    this.dispatchAuthorizations.clear();
  }

  authorizeRetry(requestId: string): boolean {
    this.assertUsable();
    const id = requireId(requestId, "requestId");
    const denial = this.recentAutoDenials.get(id);
    if (
      !denial ||
      denial.runId !== this.currentRunId ||
      denial.policyGeneration !== this.generation
    ) {
      return false;
    }
    this.recentAutoDenials.delete(id);
    this.retryMarker = { ...denial };
    return true;
  }

  async authorize(
    request: ApprovalActionRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<ApprovalAuthorizationResult> {
    this.assertUsable();
    const action = freezeAction(request, this.key);
    const ownerRetry = this.consumeRetryMarker(action);
    if (
      this.currentRunId !== action.runId ||
      (this.seenRequests.has(action.requestId) && !ownerRetry)
    ) {
      return refusal("stale", "The approval request no longer belongs to the active run.", this.circuitOpen);
    }
    if (options.signal?.aborted) {
      return refusal("cancelled", undefined, this.circuitOpen);
    }

    this.seenRequests.add(action.requestId);
    const admittedGeneration = this.generation;
    const pendingController = new AbortController();
    this.pending.set(action.requestId, pendingController);
    const detachAbort = forwardAbort(options.signal, pendingController);

    try {
      const evaluation = await abortable(this.policy(action), pendingController.signal);
      if (!this.isCurrent(action, admittedGeneration)) {
        return refusal("stale", "Approval policy or run identity changed.", this.circuitOpen);
      }
      const policyDecision = effectivePolicyDecision(evaluation, this.mode);
      const result = await this.resolve(action, policyDecision, pendingController.signal, ownerRetry);
      if (!this.isCurrent(action, admittedGeneration)) {
        return refusal("stale", "Approval policy or run identity changed.", this.circuitOpen);
      }
      if (!result.authorized) {
        if (
          result.source === "reviewer" &&
          (result.outcome === "deny" || result.outcome === "circuit-open")
        ) {
          this.rememberAutoDenial(action, admittedGeneration);
        }
        await this.record(action, policyDecision, result.source, result.outcome, result.rationale);
        return refusal(result.outcome, result.rationale, this.circuitOpen);
      }

      // Owner/reviewer decisions may wait while filesystem aliases, sandbox
      // policy, or other boundary inputs change. Re-evaluate at the last
      // controller-owned dispatch seam and refuse any changed policy result.
      const revalidatedDecision = effectivePolicyDecision(
        await abortable(this.policy(action), pendingController.signal),
        this.mode,
      );
      if (
        !this.isCurrent(action, admittedGeneration) ||
        !samePolicyDecision(policyDecision, revalidatedDecision)
      ) {
        const rationale = "Approval policy changed before tool dispatch.";
        await this.record(action, revalidatedDecision, "policy", "stale", rationale);
        return refusal("stale", rationale, this.circuitOpen);
      }

      const grantScope = result.decision.outcome === "allow-session" ? "session" : "once";
      if (grantScope === "session") {
        if (!action.grantKey) {
          const rationale = "A session approval requires a normalized grant key.";
          await this.record(action, policyDecision, result.source, "deny", rationale);
          return refusal("deny", rationale, this.circuitOpen);
        }
        this.sessionGrants.add(action.grantKey);
      }
      const authorizationId = `${action.requestId}:${this.generation}:${++this.authorizationSequence}`;
      this.dispatchAuthorizations.set(authorizationId, {
        fingerprint: action.inputFingerprint,
        policyGeneration: admittedGeneration,
        runId: action.runId,
      });
      await this.record(
        action,
        policyDecision,
        result.source,
        result.decision.outcome,
        result.decision.rationale,
      );
      return {
        authorized: true,
        authorizationId,
        fingerprint: action.inputFingerprint,
        source: result.source,
        grantScope,
      };
    } catch (error) {
      if (isAbort(error) || pendingController.signal.aborted) {
        await this.record(action, stalePolicyDecision(), "policy", "cancelled");
        return refusal("cancelled", undefined, this.circuitOpen);
      }
      const rationale = boundedRationale(error instanceof Error ? error.message : "Approval failed.");
      await this.record(action, stalePolicyDecision(), "policy", "unavailable", rationale);
      return refusal("unavailable", rationale, this.circuitOpen);
    } finally {
      detachAbort();
      this.pending.delete(action.requestId);
      if (!this.disposed && !this.activeAutoRequestId) {
        this.reviewerState = reviewerStateForMode(this.mode);
      }
    }
  }

  consumeAuthorization(input: {
    authorizationId: string;
    runId: string;
    input: unknown;
  }): FrozenApprovalInput {
    this.assertUsable();
    const authorization = this.dispatchAuthorizations.get(input.authorizationId);
    this.dispatchAuthorizations.delete(input.authorizationId);
    if (
      !authorization ||
      authorization.runId !== input.runId ||
      this.currentRunId !== input.runId ||
      authorization.policyGeneration !== this.generation
    ) {
      throw new Error("Approval authorization is stale or already consumed.");
    }
    const frozen = freezeApprovalInput(input.input);
    if (frozen.fingerprint !== authorization.fingerprint) {
      throw new Error("Approval input changed after authorization.");
    }
    return frozen;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.cancelPending();
    this.currentRunId = undefined;
    this.sessionGrants.clear();
    this.dispatchAuthorizations.clear();
    this.clearRetryState();
    this.activeAutoRequestId = undefined;
    this.disposed = true;
    this.reviewerState = "none";
  }

  private async resolve(
    action: FrozenApprovalAction,
    policy: ApprovalPolicyDecision,
    signal: AbortSignal,
    ownerRetry: boolean,
  ): Promise<
    | { authorized: true; decision: AgentApprovalDecision; source: ApprovalDecisionSource }
    | { authorized: false; outcome: ApprovalRefusalOutcome; rationale?: string; source: ApprovalDecisionSource }
  > {
    if (signal.aborted) {
      throw abortError();
    }
    if (policy.outcome === "deny") {
      return { authorized: false, outcome: "deny", rationale: policy.rationale, source: "policy" };
    }
    if (policy.outcome === "allow" || this.mode === "full") {
      return { authorized: true, decision: { outcome: "allow-once" }, source: "policy" };
    }
    if (policy.outcome === "review" && action.grantKey && this.sessionGrants.has(action.grantKey)) {
      return { authorized: true, decision: { outcome: "allow-once" }, source: "session-grant" };
    }
    if (this.mode === "ask" || policy.outcome === "require-owner") {
      return this.resolveWithOwner(action, policy, signal, "require-owner");
    }
    if (this.circuitOpen && !ownerRetry) {
      return {
        authorized: false,
        outcome: "circuit-open",
        rationale: AUTOMATIC_DENIAL_CIRCUIT_RATIONALE,
        source: "reviewer",
      };
    }
    return this.resolveWithReviewer(action, policy, signal, ownerRetry);
  }

  private async resolveWithReviewer(
    action: FrozenApprovalAction,
    policy: ApprovalPolicyDecision,
    signal: AbortSignal,
    ownerRetry: boolean,
  ): Promise<
    | { authorized: true; decision: AgentApprovalDecision; source: ApprovalDecisionSource }
    | { authorized: false; outcome: ApprovalRefusalOutcome; rationale?: string; source: ApprovalDecisionSource }
  > {
    if (!this.autoReviewer) {
      this.noteAutoDecision(false, action.requestId);
      return this.resolveWithOwner(action, policy, signal, "unavailable");
    }
    if (this.activeAutoRequestId) {
      return this.resolveWithOwner(
        action,
        policy,
        signal,
        "require-owner",
        "Automatic approval is already reviewing another tool call.",
      );
    }
    this.activeAutoRequestId = action.requestId;
    this.reviewerState = "reviewing";
    let decision: AgentApprovalDecision;
    try {
      const value = await abortable(
        this.autoReviewer({ action, mode: this.mode, policy, ownerRetry }, signal),
        signal,
      );
      if (!isAgentApprovalDecision(value)) {
        throw new TypeError("Automatic reviewer returned an invalid decision.");
      }
      decision = value;
    } catch (error) {
      if (isAbort(error) || signal.aborted) {
        throw error;
      }
      this.noteAutoDecision(false, action.requestId);
      return this.resolveWithOwner(action, policy, signal, "unavailable", boundedRationale(errorMessage(error)));
    } finally {
      if (this.activeAutoRequestId === action.requestId) {
        this.activeAutoRequestId = undefined;
      }
    }

    const openedCircuit = this.noteAutoDecision(decision.outcome === "deny", action.requestId);
    if (decision.outcome === "allow-once") {
      return { authorized: true, decision, source: "reviewer" };
    }
    if (decision.outcome === "allow-session") {
      throw new TypeError("Automatic reviewer cannot create a session grant.");
    }
    if (decision.outcome === "deny") {
      if (openedCircuit) {
        return {
          authorized: false,
          outcome: "circuit-open",
          rationale: boundedRationale(
            decision.rationale
              ? `${AUTOMATIC_DENIAL_CIRCUIT_RATIONALE} ${decision.rationale}`
              : AUTOMATIC_DENIAL_CIRCUIT_RATIONALE,
          ),
          source: "reviewer",
        };
      }
      return {
        authorized: false,
        outcome: "deny",
        ...(decision.rationale ? { rationale: decision.rationale } : {}),
        source: "reviewer",
      };
    }
    return this.resolveWithOwner(
      action,
      policy,
      signal,
      decision.outcome,
      decision.rationale,
    );
  }

  private async resolveWithOwner(
    action: FrozenApprovalAction,
    policy: ApprovalPolicyDecision,
    signal: AbortSignal,
    fallback: "require-owner" | "unavailable",
    fallbackRationale?: string,
  ): Promise<
    | { authorized: true; decision: AgentApprovalDecision; source: ApprovalDecisionSource }
    | { authorized: false; outcome: ApprovalRefusalOutcome; rationale?: string; source: ApprovalDecisionSource }
  > {
    if (!this.ownerResolver) {
      this.reviewerState = fallback === "unavailable" ? "unavailable" : "owner-required";
      return {
        authorized: false,
        outcome: fallback,
        ...(fallbackRationale ? { rationale: fallbackRationale } : {}),
        source: "owner",
      };
    }
    this.reviewerState = "owner-required";
    const value = await abortable(
      this.ownerResolver({ action, mode: this.mode, policy, ownerRetry: false }, signal),
      signal,
    );
    if (!isAgentApprovalDecision(value, { allowSession: true })) {
      return {
        authorized: false,
        outcome: "unavailable",
        rationale: "Owner resolver returned an invalid decision.",
        source: "owner",
      };
    }
    if (value.outcome === "allow-once" || value.outcome === "allow-session") {
      return { authorized: true, decision: value, source: "owner" };
    }
    const outcome = value.outcome === "deny" ? "deny" : value.outcome;
    return {
      authorized: false,
      outcome,
      ...(value.rationale ? { rationale: value.rationale } : {}),
      source: "owner",
    };
  }

  private noteAutoDecision(denied: boolean, requestId: string): boolean {
    const wasOpen = this.circuitOpen;
    this.consecutiveAutoDenials = denied ? this.consecutiveAutoDenials + 1 : 0;
    this.autoDecisionWindow.push(denied);
    if (this.autoDecisionWindow.length > 50) {
      this.autoDecisionWindow.shift();
    }
    const denials = this.autoDecisionWindow.reduce((count, entry) => count + Number(entry), 0);
    this.circuitOpen = this.consecutiveAutoDenials >= 3 || denials >= 10;
    if (!wasOpen && this.circuitOpen) {
      this.cancelPending(requestId);
    }
    return !wasOpen && this.circuitOpen;
  }

  private isCurrent(action: FrozenApprovalAction, generation: number): boolean {
    return !this.disposed && this.currentRunId === action.runId && this.generation === generation;
  }

  private async record(
    action: FrozenApprovalAction,
    policy: ApprovalPolicyDecision,
    source: ApprovalDecisionSource,
    outcome: ApprovalDecisionRecord["outcome"],
    rationale?: string,
  ): Promise<void> {
    if (!this.onDecision) {
      return;
    }
    try {
      await this.onDecision({
        ...this.key,
        runId: action.runId,
        requestId: action.requestId,
        toolName: action.toolName,
        mode: this.mode,
        source,
        outcome,
        fingerprint: action.inputFingerprint,
        policyRuleId: policy.ruleId,
        ...(rationale ? { rationale: boundedRationale(rationale) } : {}),
        occurredAt: this.now().toISOString(),
      });
    } catch {
      // Observability is not authorization authority.
    }
  }

  private resetTurnState(): void {
    this.seenRequests.clear();
    this.consecutiveAutoDenials = 0;
    this.autoDecisionWindow = [];
    this.circuitOpen = false;
    this.clearRetryState();
  }

  private consumeRetryMarker(action: FrozenApprovalAction): boolean {
    const marker = this.retryMarker;
    this.retryMarker = undefined;
    if (!marker) {
      return false;
    }
    return (
      marker.runId === action.runId &&
      marker.policyGeneration === this.generation &&
      marker.toolName === action.toolName &&
      marker.fingerprint === action.inputFingerprint
    );
  }

  private rememberAutoDenial(action: FrozenApprovalAction, policyGeneration: number): void {
    this.recentAutoDenials.delete(action.requestId);
    this.recentAutoDenials.set(action.requestId, {
      fingerprint: action.inputFingerprint,
      policyGeneration,
      runId: action.runId,
      toolName: action.toolName,
    });
    while (this.recentAutoDenials.size > 10) {
      const oldest = this.recentAutoDenials.keys().next().value as string | undefined;
      if (!oldest) {
        break;
      }
      this.recentAutoDenials.delete(oldest);
    }
  }

  private clearRetryState(): void {
    this.recentAutoDenials.clear();
    this.retryMarker = undefined;
  }

  private cancelPending(exceptRequestId?: string): void {
    for (const [requestId, controller] of this.pending) {
      if (requestId === exceptRequestId) {
        continue;
      }
      controller.abort();
      this.pending.delete(requestId);
    }
  }

  private advancePolicyGeneration(): void {
    this.generation += 1;
    this.revokeAll();
    this.clearRetryState();
  }

  private assertIdle(): void {
    this.assertUsable();
    if (this.currentRunId || this.pending.size > 0) {
      throw new Error("Approval mode and policy changes require an idle controller.");
    }
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new Error("Approval controller is disposed.");
    }
  }
}

function freezeAction(request: ApprovalActionRequest, key: AgentScopeKey): FrozenApprovalAction {
  if (request.scopeId !== key.scopeId || request.sessionId !== key.sessionId) {
    throw new TypeError("Approval request does not belong to this controller.");
  }
  const runId = requireId(request.runId, "runId");
  const requestId = requireId(request.requestId, "requestId");
  const toolName = requireId(request.toolName, "toolName");
  const input = freezeApprovalInput(request.input);
  const summary = optionalBoundedText(request.summary, AGENT_APPROVAL_MAX_SUMMARY_CHARS, "summary");
  const grantKey = optionalBoundedText(request.grantKey, AGENT_APPROVAL_MAX_ID_CHARS, "grantKey");
  const context = request.context === undefined ? undefined : freezeApprovalInput(request.context).value;
  return {
    ...key,
    runId,
    requestId,
    toolName,
    input: input.value,
    inputCanonical: input.canonical,
    inputFingerprint: input.fingerprint,
    ...(summary ? { summary } : {}),
    ...(grantKey ? { grantKey } : {}),
    ...(context !== undefined ? { context } : {}),
  };
}

function effectivePolicyDecision(
  evaluation: ApprovalPolicyEvaluation,
  mode: AgentApprovalMode,
): ApprovalPolicyDecision {
  if (evaluation.invariantDeny) {
    if (evaluation.invariantDeny.outcome !== "deny") {
      throw new TypeError("Invariant policy may only contribute a deny.");
    }
    return normalizePolicyDecision(evaluation.invariantDeny);
  }
  const boundary = normalizePolicyDecision(evaluation.boundary);
  const project = evaluation.project ? normalizePolicyDecision(evaluation.project) : undefined;
  if (project?.outcome === "deny") {
    return project;
  }
  if (mode === "full") {
    return { outcome: "allow", ruleId: boundary.ruleId };
  }
  return project && POLICY_STRENGTH[project.outcome] > POLICY_STRENGTH[boundary.outcome]
    ? project
    : boundary;
}

function normalizePolicyDecision(decision: ApprovalPolicyDecision): ApprovalPolicyDecision {
  if (typeof decision.outcome !== "string" || !(decision.outcome in POLICY_STRENGTH)) {
    throw new TypeError("Policy returned an unknown outcome.");
  }
  if (decision.rationale !== undefined && typeof decision.rationale !== "string") {
    throw new TypeError("Policy rationale must be a string.");
  }
  return {
    outcome: decision.outcome,
    ruleId: requireId(decision.ruleId, "policy ruleId"),
    ...(decision.rationale ? { rationale: boundedRationale(decision.rationale) } : {}),
  };
}

function samePolicyDecision(left: ApprovalPolicyDecision, right: ApprovalPolicyDecision): boolean {
  return left.outcome === right.outcome && left.ruleId === right.ruleId;
}

function canonicalJson(value: ApprovalJsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as ApprovalJsonValue)}`)
    .join(",")}}`;
}

function requireScopeKey(value: AgentScopeKey): AgentScopeKey {
  return {
    scopeId: requireId(value.scopeId, "scopeId"),
    sessionId: requireId(value.sessionId, "sessionId"),
  };
}

function requireId(value: string, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > AGENT_APPROVAL_MAX_ID_CHARS) {
    throw new TypeError(`${label} must be 1-${AGENT_APPROVAL_MAX_ID_CHARS} characters.`);
  }
  return value;
}

function optionalBoundedText(
  value: string | undefined,
  maxChars: number,
  label: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length > maxChars) {
    throw new TypeError(`${label} exceeds ${maxChars} characters.`);
  }
  return value;
}

function boundedRationale(value: string): string {
  return value.length <= AGENT_APPROVAL_MAX_RATIONALE_CHARS
    ? value
    : `${value.slice(0, AGENT_APPROVAL_MAX_RATIONALE_CHARS - 1)}…`;
}

function reviewerStateForMode(mode: AgentApprovalMode): AgentApprovalReviewerState {
  if (mode === "ask") {
    return "user";
  }
  return mode === "auto" ? "idle" : "none";
}

function stalePolicyDecision(): ApprovalPolicyDecision {
  return { outcome: "deny", ruleId: "approval.internal" };
}

function refusal(
  outcome: ApprovalRefusalOutcome,
  rationale: string | undefined,
  circuitOpen: boolean,
): ApprovalAuthorizationResult {
  return {
    authorized: false,
    outcome,
    ...(rationale ? { rationale } : {}),
    circuitOpen,
  };
}

function forwardAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) {
    return () => undefined;
  }
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function abortable<T>(value: T | Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(value).then(
      (result) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function abortError(): Error {
  const error = new Error("Approval cancelled.");
  error.name = "AbortError";
  return error;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Automatic reviewer is unavailable.";
}
