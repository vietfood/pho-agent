import type { AgentApprovalMode } from "@pho-agent/protocol";
import type { InlineExtension } from "./feature-api";
import type { AgentFeature } from "./features";
import {
  type ApprovalAuthorizationResult,
  type ApprovalController,
  type ApprovalRefusalOutcome,
} from "./approval-controller";

export const APPROVAL_FEATURE_ID = "approval-controller";
export const APPROVAL_FEATURE_VERSION = "0.1.0";

export interface ApprovalPermissionAsk {
  toolCallId: string;
  detail: unknown;
  requestId?: string;
  runId?: string;
  toolName?: string;
  summary?: string;
  grantKey?: string;
  signal?: AbortSignal;
}

export interface ApprovalToolCallInput {
  toolCallId: string;
  toolName: string;
  input: unknown;
  cwd: string;
  runId?: string;
  requestId?: string;
  summary?: string;
  grantKey?: string;
  signal?: AbortSignal;
}

export type ApprovalToolDisposition = ApprovalAuthorizationResult & {
  toolCallId: string;
  mode: AgentApprovalMode;
};

export interface ApprovalToolIdentity {
  runId?: string;
  requestId?: string;
  summary?: string;
  grantKey?: string;
  signal?: AbortSignal;
}

export type ApprovalToolIdentityResolver = (input: {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  cwd: string;
}) => ApprovalToolIdentity | undefined;

export class ApprovalBroker {
  private readonly asks = new Map<string, ApprovalPermissionAsk[]>();
  private readonly dispositions = new Map<string, ApprovalToolDisposition>();

  constructor(private readonly controller: ApprovalController) {}

  capture(ask: ApprovalPermissionAsk): void {
    const pending = this.asks.get(ask.toolCallId) ?? [];
    pending.push(ask);
    this.asks.set(ask.toolCallId, pending);
  }

  pendingFor(toolCallId: string): readonly ApprovalPermissionAsk[] {
    return this.asks.get(toolCallId) ?? [];
  }

  dispositionFor(toolCallId: string): ApprovalToolDisposition | undefined {
    return this.dispositions.get(toolCallId);
  }

  async authorizeToolCall(input: ApprovalToolCallInput): Promise<ApprovalToolDisposition> {
    const captured = this.asks.get(input.toolCallId) ?? [];
    this.asks.delete(input.toolCallId);
    const first = captured[0];
    const runId = input.runId ?? first?.runId ?? this.controller.activeRunId();
    const mode = this.controller.snapshot().mode;
    if (!runId) {
      return this.store(input.toolCallId, {
        authorized: false,
        outcome: "stale",
        rationale: "The tool call has no active approval run.",
        circuitOpen: false,
        toolCallId: input.toolCallId,
        mode,
      });
    }

    const signal = input.signal ?? first?.signal;
    const result = await this.controller.authorize(
      {
        ...this.controller.scopeKey(),
        runId,
        requestId: input.requestId ?? input.toolCallId,
        toolName: input.toolName,
        input: input.input,
        summary: input.summary ?? first?.summary,
        grantKey: input.grantKey ?? first?.grantKey,
        context: {
          cwd: input.cwd,
          permissionAsks: captured.map(({ detail, requestId, toolName }) => ({
            detail,
            ...(requestId ? { requestId } : {}),
            ...(toolName ? { toolName } : {}),
          })),
        },
      },
      signal ? { signal } : {},
    );
    if (!result.authorized) {
      return this.store(input.toolCallId, { ...result, toolCallId: input.toolCallId, mode });
    }

    try {
      this.controller.consumeAuthorization({
        authorizationId: result.authorizationId,
        runId,
        input: input.input,
      });
      return this.store(input.toolCallId, { ...result, toolCallId: input.toolCallId, mode });
    } catch (error) {
      return this.store(input.toolCallId, {
        authorized: false,
        outcome: "stale",
        rationale: error instanceof Error ? error.message : "Approval input became stale.",
        circuitOpen: this.controller.snapshot().circuitOpen,
        toolCallId: input.toolCallId,
        mode,
      });
    }
  }

  clear(toolCallId: string): void {
    this.asks.delete(toolCallId);
    this.dispositions.delete(toolCallId);
  }

  clearAll(): void {
    this.asks.clear();
    this.dispositions.clear();
  }

  private store(
    toolCallId: string,
    disposition: ApprovalToolDisposition,
  ): ApprovalToolDisposition {
    this.dispositions.set(toolCallId, disposition);
    return disposition;
  }
}

export function createApprovalFeature(options: {
  broker: ApprovalBroker;
  identityFor?: ApprovalToolIdentityResolver;
}): AgentFeature {
  return {
    id: APPROVAL_FEATURE_ID,
    version: APPROVAL_FEATURE_VERSION,
    extensionFactories: [createApprovalExtension(options)],
    expected: { extensions: 1 },
  };
}

export function createApprovalExtension(options: {
  broker: ApprovalBroker;
  identityFor?: ApprovalToolIdentityResolver;
}): InlineExtension {
  return {
    name: APPROVAL_FEATURE_ID,
    factory(pi) {
      pi.on("tool_call", async (event, ctx) => {
        const identity = options.identityFor?.({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.input,
          cwd: ctx.cwd,
        });
        const disposition = await options.broker.authorizeToolCall({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.input,
          cwd: ctx.cwd,
          ...identity,
        });
        if (disposition.authorized) {
          return undefined;
        }
        return {
          block: true,
          reason: refusalReason(disposition.outcome, disposition.rationale),
          terminate: disposition.outcome === "circuit-open",
        };
      });

      pi.on("tool_result", (event) => {
        options.broker.clear(event.toolCallId);
      });
      pi.on("session_shutdown", () => {
        options.broker.clearAll();
      });
    },
  };
}

function refusalReason(outcome: ApprovalRefusalOutcome, rationale?: string): string {
  if (rationale) {
    return rationale;
  }
  const reasons: Record<ApprovalRefusalOutcome, string> = {
    deny: "Approval policy denied this tool call.",
    "require-owner": "This tool call requires an owner decision.",
    unavailable: "Approval review is unavailable.",
    cancelled: "Approval review was cancelled.",
    stale: "Approval no longer matches this tool call.",
    "circuit-open": "Automatic approval stopped after repeated denials.",
  };
  return reasons[outcome];
}
