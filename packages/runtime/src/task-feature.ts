import { randomUUID } from "node:crypto";
import {
  COMPLETE_TASK_TOOL_NAME,
  TASK_BRIEF_CRITERION_ID_MAX_CHARS,
  TASK_BRIEF_ITEM_MAX_CHARS,
  TASK_BRIEF_MAX_CRITERIA,
  TASK_BRIEF_MAX_LIST_ITEMS,
  TASK_BRIEF_MAX_OPEN_QUESTIONS,
  TASK_BRIEF_OBJECTIVE_MAX_CHARS,
  UPDATE_TASK_BRIEF_TOOL_NAME,
  boundedTaskText,
  normalizeAgentScopeKey,
  requireAgentId,
  type AgentScopeKey,
  type CompletionOutcome,
  type EvidenceFreshness,
  type VerificationOutcome,
  type VerificationRecord,
} from "@pho-agent/protocol";
import { Type, defineTool, type InlineExtension, type ToolResultEvent } from "./feature-api";
import type { AgentFeature } from "./features";
import type {
  EvidenceProvider,
  VerificationAdapter,
  VerificationAdapterInput,
  VerificationRecordCandidate,
} from "./runtime";
import { collectEvidencePack, formatEvidencePackMessage } from "./task-evidence";
import {
  appendCompletionAssessment,
  appendEvidencePack,
  appendTaskBrief,
  appendVerificationRecord,
  buildCompletionAssessment,
  projectAgentTask,
  type TaskEntryStore,
} from "./task-state";

export const TASK_FEATURE_ID = "task-intelligence";
export const TASK_FEATURE_VERSION = "0.1.0";

export interface TaskRunBinding {
  key: AgentScopeKey;
  runId: string;
}

export interface TaskFeatureOptions {
  evidenceProviders?: readonly EvidenceProvider[];
  verificationAdapters?: readonly VerificationAdapter[];
  resolveRun(input: { cwd: string; sessionId: string }): TaskRunBinding | undefined;
  onChanged?: (key: AgentScopeKey) => void | Promise<void>;
  id?: () => string;
  now?: () => string;
  providerTimeoutMs?: number;
  aggregateTimeoutMs?: number;
}

export function createTaskFeature(options: TaskFeatureOptions): AgentFeature {
  return {
    id: TASK_FEATURE_ID,
    version: TASK_FEATURE_VERSION,
    extensionFactories: [createTaskExtension(options)],
    expected: { extensions: 1 },
  };
}

export function createTaskExtension(options: TaskFeatureOptions): InlineExtension {
  const id = options.id ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());
  return {
    name: TASK_FEATURE_ID,
    factory(pi) {
      pi.registerTool(
        defineTool({
          name: UPDATE_TASK_BRIEF_TOOL_NAME,
          label: "Task Brief",
          description: "Create or replace the session's living Task Brief. Use it for nontrivial work to state the outcome, constraints, acceptance criteria, assumptions, questions, and non-goals. It is separate from Plan and todos and does not write workspace files.",
          promptSnippet: "Create or update the living Task Brief for nontrivial work; keep outcomes separate from Plan steps and todos.",
          promptGuidelines: [
            "Use update_task_brief when a task has multiple acceptance criteria, durable constraints, or meaningful verification work.",
            "Do not create a Task Brief for trivial chat. Keep acceptance criteria measurable and update the full brief when scope changes.",
          ],
          parameters: Type.Object({
            objective: Type.String({ maxLength: TASK_BRIEF_OBJECTIVE_MAX_CHARS }),
            status: Type.Optional(Type.Union([Type.Literal("draft"), Type.Literal("active")])),
            constraints: Type.Array(Type.String({ maxLength: TASK_BRIEF_ITEM_MAX_CHARS }), { maxItems: TASK_BRIEF_MAX_LIST_ITEMS }),
            acceptanceCriteria: Type.Array(
              Type.Object({
                id: Type.String({ maxLength: TASK_BRIEF_CRITERION_ID_MAX_CHARS }),
                text: Type.String({ maxLength: TASK_BRIEF_ITEM_MAX_CHARS }),
              }),
              { maxItems: TASK_BRIEF_MAX_CRITERIA },
            ),
            assumptions: Type.Array(Type.String({ maxLength: TASK_BRIEF_ITEM_MAX_CHARS }), { maxItems: TASK_BRIEF_MAX_LIST_ITEMS }),
            openQuestions: Type.Array(Type.String({ maxLength: TASK_BRIEF_ITEM_MAX_CHARS }), { maxItems: TASK_BRIEF_MAX_OPEN_QUESTIONS }),
            nonGoals: Type.Array(Type.String({ maxLength: TASK_BRIEF_ITEM_MAX_CHARS }), { maxItems: TASK_BRIEF_MAX_LIST_ITEMS }),
          }),
          async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const binding = bindingFor(options, ctx.cwd, ctx.sessionManager.getSessionId());
            if (!binding) return taskToolError("The task controller is not bound to this run.");
            try {
              const store = taskStore(pi, ctx.sessionManager.getBranch());
              const current = projectAgentTask(store.getBranch(), binding.key).brief;
              const brief = appendTaskBrief(
                store,
                binding.key,
                {
                  objective: params.objective,
                  constraints: params.constraints,
                  acceptanceCriteria: params.acceptanceCriteria,
                  assumptions: params.assumptions,
                  openQuestions: params.openQuestions,
                  nonGoals: params.nonGoals,
                },
                {
                  id,
                  now,
                  updatedBy: "agent",
                  status: params.status ?? "active",
                  ...(current ? { expectedRevision: current.revision } : {}),
                },
              );
              await options.onChanged?.(binding.key);
              return {
                content: [{ type: "text" as const, text: `Task Brief ${current ? "updated" : "created"} (${brief.status}, revision ${brief.revision}).` }],
                details: { revision: brief.revision, status: brief.status },
              };
            } catch (error) {
              return taskToolError(error instanceof Error ? error.message : "Task Brief update failed.");
            }
          },
        }),
      );

      pi.registerTool(
        defineTool({
          name: COMPLETE_TASK_TOOL_NAME,
          label: "Complete task",
          description: "Assess every current Task Brief acceptance criterion against authoritative verification. Passed claims require linked current passed records; disclose unverified gaps honestly. This does not stop the run, approve changes, or commit files.",
          promptSnippet: "Before declaring a briefed task complete, call complete_task with one evidence-backed assessment per current acceptance criterion.",
          promptGuidelines: [
            "Use passed only with linked current passed verification IDs. Use failed with linked failed/observed evidence and an explanation.",
            "Use unverified with an honest note when no authoritative verification exists. The owner alone may accept those disclosed gaps.",
          ],
          parameters: Type.Object({
            briefRevision: Type.String(),
            criteria: Type.Array(
              Type.Object({
                criterionId: Type.String(),
                outcome: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("unverified")]),
                verificationIds: Type.Array(Type.String()),
                note: Type.Optional(Type.String({ maxLength: 2_048 })),
              }),
              { minItems: 1, maxItems: TASK_BRIEF_MAX_CRITERIA },
            ),
          }),
          async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const binding = bindingFor(options, ctx.cwd, ctx.sessionManager.getSessionId());
            if (!binding) return taskToolError("The task controller is not bound to this run.");
            try {
              const store = taskStore(pi, ctx.sessionManager.getBranch());
              const task = projectAgentTask(store.getBranch(), binding.key);
              if (!task.brief) throw new Error("Create a Task Brief before completing the task.");
              if (params.briefRevision !== task.brief.revision) {
                throw new Error("The Task Brief changed before completion. Reassess the current revision.");
              }
              const completion = buildCompletionAssessment({
                brief: task.brief,
                ledger: task.verification,
                criteria: params.criteria.map((criterion) => ({
                  criterionId: criterion.criterionId,
                  outcome: criterion.outcome as CompletionOutcome,
                  verificationIds: criterion.verificationIds,
                  ...(criterion.note ? { note: criterion.note } : {}),
                })),
                id: id(),
                createdAt: now(),
              });
              appendCompletionAssessment(store, binding.key, completion);
              await options.onChanged?.(binding.key);
              return {
                content: [{ type: "text" as const, text: completion.status === "ready" ? "Task completion is ready with every criterion passed." : "Task remains incomplete; review the disclosed failed or unverified criteria." }],
                details: completion,
              };
            } catch (error) {
              return taskToolError(error instanceof Error ? error.message : "Task completion failed.");
            }
          },
        }),
      );

      pi.on("before_agent_start", async (event, ctx) => {
        const binding = bindingFor(options, ctx.cwd, ctx.sessionManager.getSessionId());
        if (!binding) return undefined;
        const store = taskStore(pi, ctx.sessionManager.getBranch());
        const task = projectAgentTask(store.getBranch(), binding.key);
        const signal = ctx.signal ?? new AbortController().signal;
        const pack = await collectEvidencePack({
          providers: options.evidenceProviders ?? [],
          request: {
            key: binding.key,
            runId: binding.runId,
            prompt: event.prompt,
            ...(task.brief ? { taskBrief: task.brief } : {}),
            signal,
          },
          id,
          now,
          ...(options.providerTimeoutMs ? { providerTimeoutMs: options.providerTimeoutMs } : {}),
          ...(options.aggregateTimeoutMs ? { aggregateTimeoutMs: options.aggregateTimeoutMs } : {}),
        });
        if (!pack || signal.aborted) return undefined;
        appendEvidencePack(store, binding.key, pack);
        await options.onChanged?.(binding.key);
        return {
          message: {
            customType: "pho-agent.evidence-context",
            content: formatEvidencePackMessage(pack),
            display: false,
            details: { packId: pack.id, runId: pack.runId },
          },
        };
      });

      pi.on("tool_result", async (event, ctx) => {
        const binding = bindingFor(options, ctx.cwd, ctx.sessionManager.getSessionId());
        if (!binding) return undefined;
        const store = taskStore(pi, ctx.sessionManager.getBranch());
        let changed = false;
        for (const adapter of normalizeVerificationAdapters(options.verificationAdapters ?? [])) {
          try {
            const candidate = adapter.record({
              key: binding.key,
              runId: binding.runId,
              tool: projectToolResult(event),
            });
            if (!candidate) continue;
            appendVerificationRecord(store, binding.key, normalizeVerification(adapter.id, event.toolCallId, candidate, id, now));
            changed = true;
          } catch {
            // Verification is observational. A broken product adapter must not
            // fail the authoritative tool result or the owning agent run.
          }
        }
        if (changed) await options.onChanged?.(binding.key);
        return undefined;
      });
    },
  };
}

export function createCommandVerificationAdapter(): VerificationAdapter {
  return {
    id: "pho-code-settled-tools",
    record(input) {
      const { tool } = input;
      if (tool.toolName === "harness_mark") {
        return {
          outcome: tool.isError ? "failed" : "passed",
          summary: tool.isError ? "Deterministic harness verification failed." : "Deterministic harness verification passed.",
          freshness: "current",
        };
      }
      if (tool.toolName !== "bash") return undefined;
      const command = typeof tool.input.command === "string" ? tool.input.command.trim() : "";
      if (!isReviewedVerificationCommand(command)) return undefined;
      return {
        outcome: tool.isError ? "failed" : "passed",
        summary: `${tool.isError ? "Failed" : "Passed"}: ${command.slice(0, 1_920)}`,
        freshness: "current",
        subject: { kind: "command", id: command.slice(0, 1_024) },
      };
    },
  };
}

function isReviewedVerificationCommand(command: string): boolean {
  return /^(?:bun(?:\s+run)?\s+(?:test|typecheck|lint|build|test:desktop|package|test:packaged)|bun\s+test|npm\s+(?:test|run\s+(?:test|typecheck|lint|build))|pnpm\s+(?:test|run\s+(?:test|typecheck|lint|build))|yarn\s+(?:test|typecheck|lint|build))(?:\s|$)/u.test(command);
}

function bindingFor(options: TaskFeatureOptions, cwd: string, sessionId: string): TaskRunBinding | undefined {
  const binding = options.resolveRun({ cwd, sessionId });
  if (!binding) return undefined;
  return { key: normalizeAgentScopeKey(binding.key), runId: requireAgentId(binding.runId, "Task run id") };
}

function taskStore(pi: { appendEntry(customType: string, data?: unknown): void }, branch: readonly unknown[]): TaskEntryStore {
  return {
    appendCustomEntry(customType, data) {
      pi.appendEntry(customType, data);
      return "";
    },
    getBranch: () => branch,
  };
}

function taskToolError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: { error: "task_validation_failed" },
  };
}

function projectToolResult(event: ToolResultEvent): VerificationAdapterInput["tool"] {
  return {
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    input: event.input,
    content: event.content,
    details: event.details,
    isError: event.isError,
  };
}

function normalizeVerificationAdapters(adapters: readonly VerificationAdapter[]): VerificationAdapter[] {
  const ids = new Set<string>();
  return adapters.map((adapter) => {
    const id = requireAgentId(adapter.id, "Verification adapter id");
    if (ids.has(id)) throw new TypeError(`Duplicate verification adapter id: ${id}.`);
    ids.add(id);
    return adapter;
  });
}

function normalizeVerification(
  adapterId: string,
  sourceCallId: string,
  candidate: VerificationRecordCandidate,
  id: () => string,
  now: () => string,
): VerificationRecord {
  if (!isOutcome(candidate.outcome) || !isFreshness(candidate.freshness)) {
    throw new TypeError("Verification adapter returned an invalid outcome or freshness.");
  }
  return {
    ...candidate,
    id: requireAgentId(id(), "Verification id"),
    sourceAdapterId: requireAgentId(adapterId, "Verification adapter id"),
    sourceCallId: requireAgentId(sourceCallId, "Verification tool call id"),
    summary: boundedTaskText(candidate.summary, "Verification summary"),
    observedAt: now(),
  };
}

function isOutcome(value: unknown): value is VerificationOutcome {
  return value === "passed" || value === "failed" || value === "observed" || value === "unverified";
}

function isFreshness(value: unknown): value is EvidenceFreshness {
  return value === "current" || value === "stale" || value === "unknown";
}
