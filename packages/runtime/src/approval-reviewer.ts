import { Agent } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  isAgentApprovalDecision,
  type AgentApprovalDecision,
} from "@pho-agent/protocol";
import type { ApprovalResolver, ApprovalReviewRequest } from "./approval-controller";

const DEFAULT_APPROVAL_REVIEW_TIMEOUT_MS = 30_000;
const MAX_APPROVAL_REVIEW_TIMEOUT_MS = 120_000;
const DEFAULT_APPROVAL_REVIEW_CONCURRENCY = 2;

export interface SessionApprovalReviewerOptions {
  systemPrompt: string;
  buildPrompt: (request: ApprovalReviewRequest) => string;
  modelFor?: (
    source: AgentSession,
    request: ApprovalReviewRequest,
  ) => Model<Api> | undefined;
  isModelEligible?: (source: AgentSession, request: ApprovalReviewRequest) => boolean;
  timeoutMs?: number;
}

export type ApprovalSessionSource = (
  request: ApprovalReviewRequest,
) => AgentSession | undefined;

export interface ApprovalReviewerPool {
  run<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T>;
  snapshot(): { active: number; pending: number; limit: number };
}

export function createApprovalReviewerPool(
  limit = DEFAULT_APPROVAL_REVIEW_CONCURRENCY,
): ApprovalReviewerPool {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16) {
    throw new TypeError("Approval reviewer concurrency must be 1-16.");
  }
  let active = 0;
  const pending: Array<{
    signal: AbortSignal;
    resolve: () => void;
    reject: (error: Error) => void;
    onAbort: () => void;
  }> = [];

  const startNext = (): void => {
    while (active < limit && pending.length > 0) {
      const next = pending.shift();
      if (!next) return;
      next.signal.removeEventListener("abort", next.onAbort);
      if (next.signal.aborted) {
        next.reject(abortError());
        continue;
      }
      active += 1;
      next.resolve();
    }
  };

  const acquire = (signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return Promise.reject(abortError());
    if (active < limit) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const entry = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = pending.indexOf(entry);
          if (index >= 0) pending.splice(index, 1);
          reject(abortError());
        },
      };
      pending.push(entry);
      signal.addEventListener("abort", entry.onAbort, { once: true });
    });
  };

  return {
    async run<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
      await acquire(signal);
      try {
        return await work();
      } finally {
        active -= 1;
        startNext();
      }
    },
    snapshot: () => ({ active, pending: pending.length, limit }),
  };
}

export function createSessionApprovalReviewer(
  sourceFor: ApprovalSessionSource,
  options: SessionApprovalReviewerOptions,
): ApprovalResolver {
  const systemPrompt = requireText(options.systemPrompt, "Approval reviewer system prompt");
  const timeoutMs = requireTimeout(options.timeoutMs ?? DEFAULT_APPROVAL_REVIEW_TIMEOUT_MS);

  return async (request, signal) => {
    if (signal.aborted) {
      throw abortError();
    }
    const source = sourceFor(request);
    if (!source) {
      throw new Error("Approval reviewer has no active model session.");
    }
    const model = options.modelFor
      ? options.modelFor(source, request)
      : source.agent.state.model;
    if (!model) {
      throw new Error("Approval reviewer has no compatible configured model.");
    }
    if (options.isModelEligible && !options.isModelEligible(source, request)) {
      throw new Error("The active model is not eligible for automatic approval review.");
    }
    const prompt = requireText(options.buildPrompt(request), "Approval reviewer prompt");
    const sourceAgent = source.agent;
    const reviewer = new Agent({
      initialState: {
        systemPrompt,
        model,
        thinkingLevel: "off",
        tools: [],
        messages: [],
      },
      convertToLlm: sourceAgent.convertToLlm,
      streamFn: sourceAgent.streamFunction,
      getApiKey: sourceAgent.getApiKey,
      thinkingBudgets: sourceAgent.thinkingBudgets,
      transport: sourceAgent.transport,
      maxRetryDelayMs: sourceAgent.maxRetryDelayMs,
    });
    let rejectAbort!: (error: Error) => void;
    const abortPromise = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const abortReview = () => {
      reviewer.abort();
      rejectAbort(abortError());
    };
    signal.addEventListener("abort", abortReview, { once: true });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        reviewer.prompt(prompt),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            reviewer.abort();
            reject(new Error("Automatic approval review timed out."));
          }, timeoutMs);
        }),
        abortPromise,
      ]);
      return parseApprovalReviewerDecision(readAssistantText(reviewer));
    } catch (error) {
      reviewer.abort();
      // A provider transport may ignore abort. Authorization must still fail
      // closed at the timeout/cancellation boundary instead of holding Stop or
      // shutdown on an unbounded cleanup wait.
      void reviewer.waitForIdle().catch(() => undefined);
      if (signal.aborted) {
        throw abortError();
      }
      throw error;
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      signal.removeEventListener("abort", abortReview);
    }
  };
}

export function parseApprovalReviewerDecision(text: string | undefined): AgentApprovalDecision {
  if (!text) {
    throw new TypeError("Automatic reviewer returned no decision.");
  }
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch {
    throw new TypeError("Automatic reviewer must return one JSON decision object.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Automatic reviewer returned an invalid decision.");
  }
  const response = value as Record<string, unknown>;
  if (
    Object.keys(response).some((key) => key !== "version" && key !== "outcome" && key !== "rationale") ||
    response.version !== 1 ||
    typeof response.rationale !== "string" ||
    response.rationale.trim() === "" ||
    !isAgentApprovalDecision({ outcome: response.outcome, rationale: response.rationale })
  ) {
    throw new TypeError("Automatic reviewer returned an invalid decision.");
  }
  return { outcome: response.outcome as AgentApprovalDecision["outcome"], rationale: response.rationale };
}

function readAssistantText(agent: Agent): string | undefined {
  for (let index = agent.state.messages.length - 1; index >= 0; index -= 1) {
    const message = agent.state.messages[index];
    if (!message || message.role !== "assistant") {
      continue;
    }
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text) {
      return text;
    }
  }
  return undefined;
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must not be empty.`);
  }
  return value;
}

function requireTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_APPROVAL_REVIEW_TIMEOUT_MS) {
    throw new TypeError(`Approval reviewer timeout must be 1-${MAX_APPROVAL_REVIEW_TIMEOUT_MS} ms.`);
  }
  return value;
}

function abortError(): Error {
  const error = new Error("Automatic approval review cancelled.");
  error.name = "AbortError";
  return error;
}
