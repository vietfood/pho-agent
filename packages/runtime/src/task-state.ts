import {
  boundedTaskText,
  isCompletionOutcome,
  isEvidenceFreshness,
  isTaskBriefStatus,
  isVerificationOutcome,
  normalizeAgentScopeKey,
  normalizeTaskBriefContent,
  requireAgentId,
  TASK_BRIEF_MAX_CRITERIA,
  TASK_EVIDENCE_LABEL_MAX_CHARS,
  TASK_EVIDENCE_MAX_ITEM_CHARS,
  TASK_EVIDENCE_MAX_ITEMS,
  TASK_EVIDENCE_MAX_PROVIDERS,
  TASK_EVIDENCE_MAX_TOTAL_CHARS,
  TASK_VERIFICATION_MAX_RECORDS,
  type AgentScopeKey,
  type AgentTaskSnapshot,
  type CompletionAssessment,
  type CriterionAssessment,
  type EvidencePackSummary,
  type TaskBriefContent,
  type TaskBriefSnapshot,
  type VerificationLedgerSnapshot,
  type VerificationRecord,
} from "@pho-agent/protocol";

export const TASK_BRIEF_CUSTOM_TYPE = "pho-agent.task-brief";
export const TASK_EVIDENCE_CUSTOM_TYPE = "pho-agent.evidence-pack";
export const TASK_VERIFICATION_CUSTOM_TYPE = "pho-agent.verification";
export const TASK_COMPLETION_CUSTOM_TYPE = "pho-agent.completion";

export interface TaskEntryStore {
  appendCustomEntry(customType: string, data?: unknown): string;
  getBranch(): readonly unknown[];
}

interface OwnedTaskRecord<T> {
  scopeId: string;
  sessionId: string;
  value: T;
}

interface TaskBriefResetEntry extends Omit<OwnedTaskRecord<never>, "value"> {
  reset: true;
}

export function emptyAgentTaskSnapshot(): AgentTaskSnapshot {
  return { verification: { records: [], truncated: false } };
}

export function projectAgentTask(entries: readonly unknown[], keyInput: AgentScopeKey): AgentTaskSnapshot {
  const key = normalizeAgentScopeKey(keyInput);
  const sourceCallIds = collectSourceCallIds(entries);
  let brief: TaskBriefSnapshot | undefined;
  let evidence: EvidencePackSummary | undefined;
  let completion: CompletionAssessment | undefined;
  const verificationById = new Map<string, VerificationRecord>();
  let verificationCount = 0;

  for (const entry of entries) {
    const custom = customEntry(entry);
    if (!custom) continue;
    if (custom.customType === TASK_BRIEF_CUSTOM_TYPE) {
      const reset = parseTaskBriefReset(custom.data, key);
      if (reset) {
        brief = undefined;
        evidence = undefined;
        completion = undefined;
        continue;
      }
      const next = parseTaskBriefEntry(custom.data, key);
      if (next) {
        brief = next;
        if (completion?.briefRevision !== next.revision) completion = undefined;
      }
      continue;
    }
    if (custom.customType === TASK_EVIDENCE_CUSTOM_TYPE) {
      const next = parseEvidenceEntry(custom.data, key);
      if (next) evidence = next;
      continue;
    }
    if (custom.customType === TASK_VERIFICATION_CUSTOM_TYPE) {
      const record = parseVerificationEntry(custom.data, key);
      if (record) {
        verificationCount += verificationById.has(record.id) ? 0 : 1;
        verificationById.set(record.id, record);
      }
      continue;
    }
    if (custom.customType === TASK_COMPLETION_CUSTOM_TYPE) {
      const next = parseCompletionEntry(custom.data, key);
      if (next) completion = next;
    }
  }

  const deduplicatedRecords = new Map<string, VerificationRecord>();
  for (const record of verificationById.values()) {
    const validated = record.sourceCallId && !sourceCallIds.has(record.sourceCallId)
      ? {
          ...record,
          freshness: "stale" as const,
          invalidationReason: record.invalidationReason ?? "The authoritative source tool call is absent from the active branch.",
        }
      : record;
    const dedupeKey = verificationDedupeKey(validated);
    if (deduplicatedRecords.has(dedupeKey)) deduplicatedRecords.delete(dedupeKey);
    deduplicatedRecords.set(dedupeKey, validated);
  }
  const allRecords = [...deduplicatedRecords.values()];
  const records = allRecords.slice(-TASK_VERIFICATION_MAX_RECORDS);
  const verification: VerificationLedgerSnapshot = {
    records,
    truncated: verificationCount > records.length,
  };
  completion = reconcileCompletion(brief, completion, verification);
  if (brief) {
    const completed = completion?.status === "ready" || completion?.status === "accepted_with_gaps";
    brief = {
      ...brief,
      status: completed ? "completed" : brief.status === "completed" ? "active" : brief.status,
    };
  }
  return {
    ...(brief ? { brief } : {}),
    ...(evidence ? { evidence } : {}),
    verification,
    ...(completion ? { completion } : {}),
  };
}

function verificationDedupeKey(record: VerificationRecord): string {
  if (!record.sourceCallId) return `record:${record.id}`;
  return JSON.stringify([
    record.sourceAdapterId,
    record.sourceCallId,
    record.subject?.kind ?? "",
    record.subject?.id ?? "",
    record.subject?.revision ?? "",
    record.outcome,
  ]);
}

function collectSourceCallIds(entries: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    const custom = customEntry(entry);
    if (custom?.customType === TASK_VERIFICATION_CUSTOM_TYPE) continue;
    visitSource(entry, ids);
  }
  return ids;
}

function visitSource(value: unknown, ids: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => visitSource(item, ids));
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.toolCallId === "string") ids.add(record.toolCallId);
  if (record.type === "toolCall" && typeof record.id === "string") ids.add(record.id);
  Object.values(record).forEach((item) => visitSource(item, ids));
}

export function appendTaskBrief(
  store: TaskEntryStore,
  keyInput: AgentScopeKey,
  content: TaskBriefContent,
  options: {
    id: () => string;
    now: () => string;
    updatedBy: "agent" | "owner";
    status?: "draft" | "active";
    expectedRevision?: string;
  },
): TaskBriefSnapshot {
  const key = normalizeAgentScopeKey(keyInput);
  const current = projectAgentTask(store.getBranch(), key).brief;
  assertExpectedRevision(current, options.expectedRevision);
  const status = options.status ?? "active";
  const value: TaskBriefSnapshot = {
    ...normalizeTaskBriefContent(content, status),
    revision: requireAgentId(options.id(), "Task Brief revision"),
    status,
    updatedAt: options.now(),
    updatedBy: options.updatedBy,
  };
  appendOwned(store, TASK_BRIEF_CUSTOM_TYPE, key, value);
  return value;
}

export function resetTaskBrief(
  store: TaskEntryStore,
  keyInput: AgentScopeKey,
  expectedRevision?: string,
): void {
  const key = normalizeAgentScopeKey(keyInput);
  const current = projectAgentTask(store.getBranch(), key).brief;
  assertExpectedRevision(current, expectedRevision);
  const value: TaskBriefResetEntry = { ...key, reset: true };
  store.appendCustomEntry(TASK_BRIEF_CUSTOM_TYPE, value);
}

export function reopenTaskBrief(
  store: TaskEntryStore,
  keyInput: AgentScopeKey,
  options: { id: () => string; now: () => string },
): TaskBriefSnapshot {
  const key = normalizeAgentScopeKey(keyInput);
  const current = projectAgentTask(store.getBranch(), key).brief;
  if (!current) throw new Error("The session has no Task Brief to reopen.");
  if (current.status !== "completed" && current.status !== "cancelled") {
    throw new Error("Only a completed or cancelled Task Brief can be reopened.");
  }
  return appendTaskBrief(store, key, current, {
    ...options,
    expectedRevision: current.revision,
    status: "active",
    updatedBy: "owner",
  });
}

export function appendEvidencePack(store: TaskEntryStore, keyInput: AgentScopeKey, value: EvidencePackSummary): void {
  appendOwned(store, TASK_EVIDENCE_CUSTOM_TYPE, normalizeAgentScopeKey(keyInput), value);
}

export function appendVerificationRecord(
  store: TaskEntryStore,
  keyInput: AgentScopeKey,
  value: VerificationRecord,
): void {
  appendOwned(store, TASK_VERIFICATION_CUSTOM_TYPE, normalizeAgentScopeKey(keyInput), value);
}

export function appendCompletionAssessment(
  store: TaskEntryStore,
  keyInput: AgentScopeKey,
  value: CompletionAssessment,
): void {
  appendOwned(store, TASK_COMPLETION_CUSTOM_TYPE, normalizeAgentScopeKey(keyInput), value);
}

export function buildCompletionAssessment(input: {
  brief: TaskBriefSnapshot;
  ledger: VerificationLedgerSnapshot;
  criteria: readonly CriterionAssessment[];
  id: string;
  createdAt: string;
}): CompletionAssessment {
  const expected = new Map(input.brief.acceptanceCriteria.map((criterion) => [criterion.id, criterion]));
  if (input.criteria.length !== expected.size) {
    throw new TypeError("Completion must assess every current acceptance criterion exactly once.");
  }
  const seen = new Set<string>();
  const records = new Map(input.ledger.records.map((record) => [record.id, record]));
  const criteria = input.criteria.map((candidate): CriterionAssessment => {
    const criterionId = requireAgentId(candidate.criterionId, "Task criterion id");
    if (!expected.has(criterionId) || seen.has(criterionId)) {
      throw new TypeError(`Completion contains an unknown or duplicate criterion: ${criterionId}.`);
    }
    seen.add(criterionId);
    if (!isCompletionOutcome(candidate.outcome)) throw new TypeError("Completion outcome is invalid.");
    const verificationIds = candidate.verificationIds.map((id) => requireAgentId(id, "Verification id"));
    if (new Set(verificationIds).size !== verificationIds.length) {
      throw new TypeError(`Completion contains duplicate verification ids for ${criterionId}.`);
    }
    const linked = verificationIds.map((id) => {
      const record = records.get(id);
      if (!record) throw new TypeError(`Completion references unknown verification: ${id}.`);
      if (record.criterionId && record.criterionId !== criterionId) {
        throw new TypeError(`Verification ${id} belongs to a different criterion.`);
      }
      return record;
    });
    const note = candidate.note?.trim();
    if (note && note.length > 2_048) throw new TypeError("Completion notes must not exceed 2048 characters.");
    if (candidate.outcome === "passed") {
      if (!hasCurrentPassedVerification(criterionId, verificationIds, input.ledger)) {
        throw new TypeError(`Passed criterion ${criterionId} requires current passed verification.`);
      }
    } else if (candidate.outcome === "failed") {
      const supported = linked.some(
        (record) => record.freshness === "current" && (record.outcome === "failed" || record.outcome === "observed"),
      );
      if (!supported || !note) {
        throw new TypeError(`Failed criterion ${criterionId} requires current failed/observed evidence and a note.`);
      }
    } else {
      if (!note) throw new TypeError(`Unverified criterion ${criterionId} requires an honest note.`);
      if (hasCurrentCriterionFailure(criterionId, input.ledger)) {
        throw new TypeError(`Unverified criterion ${criterionId} has current failed verification and must be reported as failed.`);
      }
    }
    return {
      criterionId,
      outcome: candidate.outcome,
      verificationIds,
      ...(note ? { note } : {}),
    };
  });
  return {
    id: requireAgentId(input.id, "Completion id"),
    briefRevision: input.brief.revision,
    status: criteria.every((criterion) => criterion.outcome === "passed") ? "ready" : "incomplete",
    criteria,
    createdAt: input.createdAt,
  };
}

export function acceptCompletionGaps(
  completion: CompletionAssessment | undefined,
  acceptedAt: string,
): CompletionAssessment {
  if (!completion || completion.status !== "incomplete") {
    throw new Error("The task has no incomplete completion assessment to accept.");
  }
  if (completion.criteria.some((criterion) => criterion.outcome === "failed")) {
    throw new Error("Failed criteria cannot be accepted as completion gaps.");
  }
  if (completion.criteria.every((criterion) => criterion.outcome === "passed")) {
    throw new Error("The task has no unverified completion gaps.");
  }
  return { ...completion, status: "accepted_with_gaps", acceptedByOwnerAt: acceptedAt };
}

function appendOwned<T>(store: TaskEntryStore, customType: string, key: AgentScopeKey, value: T): void {
  const record: OwnedTaskRecord<T> = { ...key, value };
  store.appendCustomEntry(customType, record);
}

function reconcileCompletion(
  brief: TaskBriefSnapshot | undefined,
  completion: CompletionAssessment | undefined,
  ledger: VerificationLedgerSnapshot,
): CompletionAssessment | undefined {
  if (!completion) return undefined;
  if (!brief || completion.briefRevision !== brief.revision) return undefined;
  const expectedCriteria = new Set(brief.acceptanceCriteria.map((criterion) => criterion.id));
  const criteriaMatch = completion.criteria.length === expectedCriteria.size && completion.criteria.every(
    (criterion) => expectedCriteria.delete(criterion.criterionId),
  );
  const passedLinksRemainCurrent = completion.criteria.every((criterion) =>
    criterion.outcome !== "passed" || hasCurrentPassedVerification(criterion.criterionId, criterion.verificationIds, ledger));
  const acceptedGapHasFailure = completion.status === "accepted_with_gaps" && completion.criteria.some(
    (criterion) => criterion.outcome === "unverified" && hasCurrentCriterionFailure(criterion.criterionId, ledger),
  );
  if (!criteriaMatch || !passedLinksRemainCurrent || acceptedGapHasFailure) {
    const { acceptedByOwnerAt: _acceptedByOwnerAt, ...invalidated } = completion;
    return { ...invalidated, status: "incomplete" };
  }
  return completion;
}

function hasCurrentPassedVerification(
  criterionId: string,
  verificationIds: readonly string[],
  ledger: VerificationLedgerSnapshot,
): boolean {
  const linked = new Set(verificationIds);
  let latestLinkedPass = -1;
  let latestCriterionFailure = -1;
  ledger.records.forEach((record, index) => {
    if (record.freshness !== "current" || record.invalidatedAt) return;
    if (linked.has(record.id) && record.outcome === "passed") latestLinkedPass = index;
    if (record.criterionId === criterionId && record.outcome === "failed") latestCriterionFailure = index;
  });
  return latestLinkedPass >= 0 && latestLinkedPass > latestCriterionFailure;
}

function hasCurrentCriterionFailure(criterionId: string, ledger: VerificationLedgerSnapshot): boolean {
  return ledger.records.some(
    (record) =>
      record.criterionId === criterionId &&
      record.outcome === "failed" &&
      record.freshness === "current" &&
      !record.invalidatedAt,
  );
}

function assertExpectedRevision(current: TaskBriefSnapshot | undefined, expected: string | undefined): void {
  if (expected === undefined) {
    if (current) throw new Error("Task Brief expectedRevision is required when replacing an existing brief.");
    return;
  }
  if (!current || current.revision !== expected) {
    throw new Error("The Task Brief changed before this update. Refresh and try again.");
  }
}

function customEntry(value: unknown): { customType: string; data: unknown } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as { type?: unknown; customType?: unknown; data?: unknown };
  return record.type === "custom" && typeof record.customType === "string"
    ? { customType: record.customType, data: record.data }
    : undefined;
}

function ownedValue(value: unknown, key: AgentScopeKey): unknown | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as { scopeId?: unknown; sessionId?: unknown; value?: unknown };
  return record.scopeId === key.scopeId && record.sessionId === key.sessionId ? record.value : undefined;
}

function parseTaskBriefReset(value: unknown, key: AgentScopeKey): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<TaskBriefResetEntry>;
  return record.scopeId === key.scopeId && record.sessionId === key.sessionId && record.reset === true;
}

function parseTaskBriefEntry(value: unknown, key: AgentScopeKey): TaskBriefSnapshot | undefined {
  const candidate = ownedValue(value, key);
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const record = candidate as Partial<TaskBriefSnapshot>;
  try {
    if (!isTaskBriefStatus(record.status) || (record.updatedBy !== "agent" && record.updatedBy !== "owner")) return undefined;
    if (typeof record.updatedAt !== "string") return undefined;
    return {
      ...normalizeTaskBriefContent(record as TaskBriefContent, record.status === "draft" ? "draft" : "active"),
      revision: requireAgentId(record.revision, "Task Brief revision"),
      status: record.status,
      updatedAt: record.updatedAt,
      updatedBy: record.updatedBy,
    };
  } catch {
    return undefined;
  }
}

function parseEvidenceEntry(value: unknown, key: AgentScopeKey): EvidencePackSummary | undefined {
  const candidate = ownedValue(value, key);
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const record = candidate as Partial<EvidencePackSummary>;
  try {
    if (!Array.isArray(record.items) || record.items.length > TASK_EVIDENCE_MAX_ITEMS) return undefined;
    if (!Array.isArray(record.failedProviders) || record.failedProviders.length > TASK_EVIDENCE_MAX_PROVIDERS) return undefined;
    if (typeof record.generatedAt !== "string" || typeof record.truncated !== "boolean") return undefined;
    const characterCount = nonNegativeInteger(record.characterCount, TASK_EVIDENCE_MAX_TOTAL_CHARS);
    const items = record.items.map((item) => parseEvidenceItem(item));
    if (items.reduce((total, item) => total + item.excerpt.length, 0) !== characterCount) return undefined;
    return {
      id: requireAgentId(record.id, "Evidence pack id"),
      runId: requireAgentId(record.runId, "Evidence run id"),
      ...(record.briefRevision ? { briefRevision: requireAgentId(record.briefRevision, "Task Brief revision") } : {}),
      generatedAt: record.generatedAt,
      items,
      omittedCount: nonNegativeInteger(record.omittedCount),
      failedProviders: record.failedProviders.map((provider) => requireAgentId(provider, "Failed evidence provider id")),
      estimatedTokens: nonNegativeInteger(record.estimatedTokens, Math.ceil(TASK_EVIDENCE_MAX_TOTAL_CHARS / 4)),
      characterCount,
      truncated: record.truncated,
    };
  } catch {
    return undefined;
  }
}

function parseVerificationEntry(value: unknown, key: AgentScopeKey): VerificationRecord | undefined {
  const candidate = ownedValue(value, key);
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const record = candidate as Partial<VerificationRecord>;
  try {
    if (!isVerificationOutcome(record.outcome) || !isEvidenceFreshness(record.freshness)) return undefined;
    if (typeof record.observedAt !== "string") return undefined;
    const subject = parseVerificationSubject(record.subject);
    return {
      id: requireAgentId(record.id, "Verification id"),
      sourceAdapterId: requireAgentId(record.sourceAdapterId, "Verification adapter id"),
      ...(record.sourceEntryId ? { sourceEntryId: requireAgentId(record.sourceEntryId, "Verification source entry id") } : {}),
      ...(record.sourceCallId ? { sourceCallId: requireAgentId(record.sourceCallId, "Verification source call id") } : {}),
      ...(record.criterionId ? { criterionId: requireAgentId(record.criterionId, "Task criterion id") } : {}),
      outcome: record.outcome,
      summary: boundedTaskText(record.summary, "Verification summary"),
      ...(subject ? { subject } : {}),
      freshness: record.freshness,
      observedAt: record.observedAt,
      ...(record.invalidatedAt ? { invalidatedAt: boundedTaskText(record.invalidatedAt, "Verification invalidation time") } : {}),
      ...(record.invalidationReason
        ? { invalidationReason: boundedTaskText(record.invalidationReason, "Verification invalidation reason") }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function parseCompletionEntry(value: unknown, key: AgentScopeKey): CompletionAssessment | undefined {
  const candidate = ownedValue(value, key);
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const record = candidate as Partial<CompletionAssessment>;
  try {
    if (
      typeof record.createdAt !== "string" ||
      (record.status !== "incomplete" && record.status !== "ready" && record.status !== "accepted_with_gaps") ||
      !Array.isArray(record.criteria) ||
      record.criteria.length > TASK_BRIEF_MAX_CRITERIA
    ) return undefined;
    const criteria = record.criteria.map((criterion) => parseCriterionAssessment(criterion));
    const criterionIds = new Set(criteria.map((criterion) => criterion.criterionId));
    if (criterionIds.size !== criteria.length) return undefined;
    if (record.status === "ready" && criteria.some((criterion) => criterion.outcome !== "passed")) return undefined;
    if (
      record.status === "accepted_with_gaps" &&
      (criteria.some((criterion) => criterion.outcome === "failed") ||
        criteria.every((criterion) => criterion.outcome === "passed") ||
        typeof record.acceptedByOwnerAt !== "string")
    ) return undefined;
    return {
      id: requireAgentId(record.id, "Completion id"),
      briefRevision: requireAgentId(record.briefRevision, "Task Brief revision"),
      status: record.status,
      criteria,
      createdAt: record.createdAt,
      ...(record.acceptedByOwnerAt ? { acceptedByOwnerAt: record.acceptedByOwnerAt } : {}),
    };
  } catch {
    return undefined;
  }
}

function parseEvidenceItem(value: unknown): EvidencePackSummary["items"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Evidence item is invalid.");
  const item = value as Partial<EvidencePackSummary["items"][number]>;
  if (!isEvidenceFreshness(item.freshness) || !Number.isFinite(item.relevance)) {
    throw new TypeError("Evidence item freshness or relevance is invalid.");
  }
  const relevance = item.relevance as number;
  if (relevance < 0 || relevance > 1) throw new TypeError("Evidence relevance is out of range.");
  return {
    id: requireAgentId(item.id, "Evidence item id"),
    providerId: requireAgentId(item.providerId, "Evidence provider id"),
    sourceId: requireAgentId(item.sourceId, "Evidence source id"),
    title: boundedTaskText(item.title, "Evidence title", TASK_EVIDENCE_LABEL_MAX_CHARS),
    excerpt: boundedTaskText(item.excerpt, "Evidence excerpt", TASK_EVIDENCE_MAX_ITEM_CHARS),
    ...(item.displayLocator
      ? { displayLocator: boundedTaskText(item.displayLocator, "Evidence display locator", TASK_EVIDENCE_LABEL_MAX_CHARS) }
      : {}),
    relevance,
    freshness: item.freshness,
    contentHash: requireAgentId(item.contentHash, "Evidence content hash"),
    selectionReason: boundedTaskText(item.selectionReason, "Evidence selection reason"),
  };
}

function parseVerificationSubject(value: unknown): VerificationRecord["subject"] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Verification subject is invalid.");
  const subject = value as { kind?: unknown; id?: unknown; revision?: unknown };
  return {
    kind: boundedTaskText(subject.kind, "Verification subject kind", 128),
    id: requireAgentId(subject.id, "Verification subject id"),
    ...(subject.revision ? { revision: requireAgentId(subject.revision, "Verification subject revision") } : {}),
  };
}

function parseCriterionAssessment(value: unknown): CriterionAssessment {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Completion criterion is invalid.");
  const criterion = value as Partial<CriterionAssessment>;
  if (!isCompletionOutcome(criterion.outcome) || !Array.isArray(criterion.verificationIds)) {
    throw new TypeError("Completion criterion outcome or verification ids are invalid.");
  }
  const verificationIds = criterion.verificationIds.map((id) => requireAgentId(id, "Verification id"));
  if (new Set(verificationIds).size !== verificationIds.length) throw new TypeError("Duplicate completion verification id.");
  const note = criterion.note?.trim();
  if (note && note.length > 2_048) throw new TypeError("Completion notes must not exceed 2048 characters.");
  if (criterion.outcome !== "passed" && !note) throw new TypeError("Non-passed completion criteria require a note.");
  return {
    criterionId: requireAgentId(criterion.criterionId, "Task criterion id"),
    outcome: criterion.outcome,
    verificationIds,
    ...(note ? { note } : {}),
  };
}

function nonNegativeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new TypeError("Task count is invalid.");
  }
  return value as number;
}
