import type { AgentScopeKey } from "./identity";

export const UPDATE_TASK_BRIEF_TOOL_NAME = "update_task_brief";
export const COMPLETE_TASK_TOOL_NAME = "complete_task";

export const TASK_BRIEF_OBJECTIVE_MAX_CHARS = 4_096;
export const TASK_BRIEF_MAX_CRITERIA = 32;
export const TASK_BRIEF_MAX_LIST_ITEMS = 32;
export const TASK_BRIEF_MAX_OPEN_QUESTIONS = 16;
export const TASK_BRIEF_CRITERION_ID_MAX_CHARS = 64;
export const TASK_BRIEF_ITEM_MAX_CHARS = 1_024;
export const TASK_BRIEF_MAX_BYTES = 64 * 1_024;
export const TASK_EVIDENCE_MAX_PROVIDERS = 8;
export const TASK_EVIDENCE_MAX_CANDIDATES_PER_PROVIDER = 64;
export const TASK_EVIDENCE_MAX_ITEMS = 24;
export const TASK_EVIDENCE_MAX_ITEM_CHARS = 16 * 1_024;
export const TASK_EVIDENCE_MAX_TOTAL_CHARS = 64 * 1_024;
export const TASK_EVIDENCE_SOFT_TOKEN_TARGET = 12_000;
export const TASK_EVIDENCE_LABEL_MAX_CHARS = 512;
export const TASK_VERIFICATION_MAX_RECORDS = 256;
export const TASK_VERIFICATION_SUMMARY_MAX_CHARS = 2_048;

export const TASK_BRIEF_STATUSES = ["draft", "active", "completed", "cancelled"] as const;
export type TaskBriefStatus = (typeof TASK_BRIEF_STATUSES)[number];

export interface TaskAcceptanceCriterion {
  id: string;
  text: string;
}

export interface TaskBriefContent {
  objective: string;
  constraints: string[];
  acceptanceCriteria: TaskAcceptanceCriterion[];
  assumptions: string[];
  openQuestions: string[];
  nonGoals: string[];
}

export interface TaskBriefSnapshot extends TaskBriefContent {
  revision: string;
  status: TaskBriefStatus;
  updatedAt: string;
  updatedBy: "agent" | "owner";
}

export type EvidenceFreshness = "current" | "stale" | "unknown";
export type EvidenceSensitivity = "ordinary" | "restricted";

export interface EvidenceCandidate {
  id: string;
  providerId: string;
  sourceId: string;
  title: string;
  content: string;
  displayLocator?: string;
  relevance: number;
  freshness: EvidenceFreshness;
  contentHash: string;
  mandatory?: boolean;
  sensitivity?: EvidenceSensitivity;
}

export interface EvidencePackItem {
  id: string;
  providerId: string;
  sourceId: string;
  title: string;
  excerpt: string;
  displayLocator?: string;
  relevance: number;
  freshness: EvidenceFreshness;
  contentHash: string;
  selectionReason: string;
}

export interface EvidencePackSummary {
  id: string;
  runId: string;
  briefRevision?: string;
  generatedAt: string;
  items: EvidencePackItem[];
  omittedCount: number;
  failedProviders: string[];
  estimatedTokens: number;
  characterCount: number;
  truncated: boolean;
}

export const VERIFICATION_OUTCOMES = ["passed", "failed", "observed", "unverified"] as const;
export type VerificationOutcome = (typeof VERIFICATION_OUTCOMES)[number];

export interface VerificationSubject {
  kind: string;
  id: string;
  revision?: string;
}

export interface VerificationRecord {
  id: string;
  sourceAdapterId: string;
  sourceEntryId?: string;
  sourceCallId?: string;
  criterionId?: string;
  outcome: VerificationOutcome;
  summary: string;
  subject?: VerificationSubject;
  freshness: EvidenceFreshness;
  observedAt: string;
  invalidatedAt?: string;
  invalidationReason?: string;
}

export interface VerificationLedgerSnapshot {
  records: VerificationRecord[];
  truncated: boolean;
}

export const COMPLETION_OUTCOMES = ["passed", "failed", "unverified"] as const;
export type CompletionOutcome = (typeof COMPLETION_OUTCOMES)[number];

export interface CriterionAssessment {
  criterionId: string;
  outcome: CompletionOutcome;
  verificationIds: string[];
  note?: string;
}

export interface CompletionAssessment {
  id: string;
  briefRevision: string;
  status: "incomplete" | "ready" | "accepted_with_gaps";
  criteria: CriterionAssessment[];
  createdAt: string;
  acceptedByOwnerAt?: string;
}

export interface AgentTaskSnapshot {
  brief?: TaskBriefSnapshot;
  evidence?: EvidencePackSummary;
  verification: VerificationLedgerSnapshot;
  completion?: CompletionAssessment;
}

export interface AgentUpdateTaskBriefInput extends AgentScopeKey {
  expectedRevision?: string;
  status?: "draft" | "active";
  content: TaskBriefContent;
}

export interface AgentResetTaskBriefInput extends AgentScopeKey {
  expectedRevision?: string;
}

export type AgentReopenTaskInput = AgentScopeKey;

export interface AgentRecordOwnerVerificationInput extends AgentScopeKey {
  criterionId?: string;
  outcome: "passed" | "failed" | "observed" | "unverified";
  summary: string;
}

export type AgentAcceptTaskCompletionGapsInput = AgentScopeKey;

export function normalizeTaskBriefContent(
  value: TaskBriefContent,
  status: "draft" | "active" = "active",
): TaskBriefContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Task Brief content is required.");
  }
  const objective = boundedText(value.objective, "Task objective", TASK_BRIEF_OBJECTIVE_MAX_CHARS, false);
  const acceptanceCriteria = normalizeCriteria(value.acceptanceCriteria ?? []);
  if (status !== "draft" && acceptanceCriteria.length === 0) {
    throw new TypeError("An active Task Brief requires at least one acceptance criterion.");
  }
  const normalized: TaskBriefContent = {
    objective,
    constraints: normalizeTextList(value.constraints, "constraint", TASK_BRIEF_MAX_LIST_ITEMS),
    acceptanceCriteria,
    assumptions: normalizeTextList(value.assumptions, "assumption", TASK_BRIEF_MAX_LIST_ITEMS),
    openQuestions: normalizeTextList(value.openQuestions, "open question", TASK_BRIEF_MAX_OPEN_QUESTIONS),
    nonGoals: normalizeTextList(value.nonGoals, "non-goal", TASK_BRIEF_MAX_LIST_ITEMS),
  };
  if (utf8ByteLength(JSON.stringify(normalized)) > TASK_BRIEF_MAX_BYTES) {
    throw new TypeError(`Task Brief content must not exceed ${TASK_BRIEF_MAX_BYTES} bytes.`);
  }
  return normalized;
}

export function isTaskBriefStatus(value: unknown): value is TaskBriefStatus {
  return typeof value === "string" && TASK_BRIEF_STATUSES.includes(value as TaskBriefStatus);
}

export function isEvidenceFreshness(value: unknown): value is EvidenceFreshness {
  return value === "current" || value === "stale" || value === "unknown";
}

export function isVerificationOutcome(value: unknown): value is VerificationOutcome {
  return typeof value === "string" && VERIFICATION_OUTCOMES.includes(value as VerificationOutcome);
}

export function isCompletionOutcome(value: unknown): value is CompletionOutcome {
  return typeof value === "string" && COMPLETION_OUTCOMES.includes(value as CompletionOutcome);
}

export function boundedTaskText(
  value: unknown,
  label: string,
  maxChars = TASK_VERIFICATION_SUMMARY_MAX_CHARS,
): string {
  return boundedText(value, label, maxChars, false);
}

function normalizeCriteria(value: unknown): TaskAcceptanceCriterion[] {
  if (!Array.isArray(value) || value.length > TASK_BRIEF_MAX_CRITERIA) {
    throw new TypeError(`Task Brief acceptance criteria must contain at most ${TASK_BRIEF_MAX_CRITERIA} items.`);
  }
  const ids = new Set<string>();
  const texts = new Set<string>();
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new TypeError(`Task acceptance criterion ${index + 1} is invalid.`);
    }
    const record = candidate as { id?: unknown; text?: unknown };
    const id = boundedText(record.id, "Task criterion id", TASK_BRIEF_CRITERION_ID_MAX_CHARS, false);
    const text = boundedText(record.text, "Task criterion text", TASK_BRIEF_ITEM_MAX_CHARS, false);
    const normalizedText = text.replace(/\s+/gu, " ").toLocaleLowerCase();
    if (ids.has(id)) throw new TypeError(`Duplicate Task criterion id: ${id}.`);
    if (texts.has(normalizedText)) throw new TypeError(`Duplicate Task criterion text: ${text}.`);
    ids.add(id);
    texts.add(normalizedText);
    return { id, text };
  });
}

function normalizeTextList(value: unknown, label: string, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new TypeError(`Task Brief ${label}s must contain at most ${maxItems} items.`);
  }
  return value.map((item) => boundedText(item, `Task Brief ${label}`, TASK_BRIEF_ITEM_MAX_CHARS, false));
}

function boundedText(value: unknown, label: string, maxChars: number, allowEmpty: boolean): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string.`);
  const text = value.trim();
  if ((!allowEmpty && text.length === 0) || text.length > maxChars) {
    throw new TypeError(`${label} must contain ${allowEmpty ? `0-${maxChars}` : `1-${maxChars}`} characters.`);
  }
  return text;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}
