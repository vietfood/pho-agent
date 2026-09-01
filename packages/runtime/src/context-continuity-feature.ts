import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AgentFeature } from "./features";
import type { InlineExtension } from "./feature-api";

/**
 * Context-continuity feature (compaction Milestones 3–4).
 *
 * Gives the model a banded remaining-context signal, a bounded per-session
 * notes file, and read-only history lookup over the active branch. The notes
 * digest later backs the Pho cutover hook; Pi's default summarizer stays
 * unchanged unless the cutover hook is enabled.
 */

export const CONTEXT_CONTINUITY_FEATURE_ID = "context-continuity";
export const CONTEXT_CONTINUITY_FEATURE_VERSION = "1.0.0";

/** Whole-file bound for the session notes sidecar. */
export const NOTES_MAX_FILE_CHARS = 24_000;
/** Per-call bound for one notes_append/notes_write payload. */
export const NOTES_MAX_WRITE_CHARS = 8_000;
/** Maximum matches returned by one history_search call. */
export const HISTORY_MAX_MATCHES = 20;
/** Snippet length per history_search match. */
export const HISTORY_SNIPPET_CHARS = 200;
/** Maximum characters returned by one history_read call. */
export const HISTORY_READ_MAX_CHARS = 8_000;

/** Remaining-context percentages at which the budget line is injected. */
export const CONTEXT_BUDGET_BANDS = [50, 25, 10] as const;

export const NOTES_FILE_SUFFIX = ".notes.md";

/**
 * Sidecar path for a session: beside the Pi JSONL, owned by the session. The
 * name keys on the session id only, because Pi JSONL filenames carry a
 * timestamp prefix that changes across forks.
 */
export function sessionNotesPath(sessionDir: string, sessionId: string): string {
  return path.join(sessionDir, `${sessionId}${NOTES_FILE_SUFFIX}`);
}

/** Bound for the digest the cutover hook stores on the compaction entry. */
export const CUTOVER_DIGEST_MAX_CHARS = 32_000;

/**
 * In-process channel from the `new_context` tool to the host runtime. The
 * tool records a request mid-run; the host consumes it once the turn settles
 * and runs the same path as a manual compact. Keys are per session.
 */
export class ContextCutoverSignal {
  private readonly pending = new Set<string>();

  request(key: string): void {
    this.pending.add(key);
  }

  /** Returns true once per request; consuming always clears the key. */
  consume(key: string): boolean {
    return this.pending.delete(key);
  }

  drop(key: string): void {
    this.pending.delete(key);
  }
}

export function contextCutoverKey(cwd: string, sessionId: string): string {
  return `${cwd}:${sessionId}`;
}

export interface ContextContinuityFeatureOptions {
  /** Test seam: override where the notes sidecar lives. */
  notesPathFor?: (input: { sessionDir: string; sessionId: string }) => string;
  /** Test seam: clock for note timestamps. */
  now?: () => number;
  /**
   * Host wiring for the model-requested cutover. When omitted, the
   * `new_context` tool is not registered because no host would run phase two.
   */
  cutoverSignal?: ContextCutoverSignal;
}

export function createContextContinuityFeature(
  options: ContextContinuityFeatureOptions = {},
): AgentFeature {
  return {
    id: CONTEXT_CONTINUITY_FEATURE_ID,
    version: CONTEXT_CONTINUITY_FEATURE_VERSION,
    extensionFactories: [createContextContinuityExtension(options)],
    expected: { extensions: 1 },
  };
}

function createContextContinuityExtension(
  options: ContextContinuityFeatureOptions,
): InlineExtension {
  return {
    name: CONTEXT_CONTINUITY_FEATURE_ID,
    factory(pi) {
      const now = options.now ?? (() => Date.now());
      const notesPathFor =
        options.notesPathFor ??
        ((input: { sessionDir: string; sessionId: string }) =>
          sessionNotesPath(input.sessionDir, input.sessionId));
      // Serialize read-modify-write cycles per notes file so parallel tool
      // calls in one turn cannot interleave a lost update.
      const writeQueues = new Map<string, Promise<void>>();
      // Last announced remaining-context band; reset when usage recovers
      // (e.g. after a compaction) so a later drop re-announces.
      let lastAnnouncedBand: number | undefined;

      const notesPath = (ctx: ExtensionContext): string =>
        notesPathFor({
          sessionDir: ctx.sessionManager.getSessionDir(),
          sessionId: ctx.sessionManager.getSessionId(),
        });

      const enqueueWrite = <T>(filePath: string, task: () => Promise<T>): Promise<T> => {
        const prior = writeQueues.get(filePath) ?? Promise.resolve();
        const next = prior.then(task, task);
        writeQueues.set(
          filePath,
          next.then(
            () => undefined,
            () => undefined,
          ),
        );
        return next;
      };

      pi.on("context", async (event, ctx) => {
        const usage = ctx.getContextUsage();
        if (!usage || usage.percent === null || usage.tokens === null) {
          return undefined;
        }
        const remainingPercent = 100 - usage.percent;
        const band = budgetBand(remainingPercent);
        if (band === undefined) {
          lastAnnouncedBand = undefined;
          return undefined;
        }
        if (band === lastAnnouncedBand) {
          return undefined;
        }
        lastAnnouncedBand = band;
        // The context event's messages are a request-only copy, so this line
        // never persists to the session JSONL.
        return {
          messages: [
            ...event.messages,
            {
              role: "user",
              content: [{ type: "text" as const, text: budgetLine(band, usage.tokens, usage.contextWindow) }],
              timestamp: now(),
            },
          ],
        };
      });

      pi.registerTool(
        defineTool({
          name: "notes_append",
          label: "Notes append",
          description:
            "Append a timestamped note to this session's persistent notes file. The notes survive context compaction, so keep durable state (decisions, file paths, pending work) here.",
          promptSnippet: "append a durable note that survives context compaction",
          promptGuidelines: [
            "Keep the notes file current as you work: record decisions, key file paths, and pending next steps.",
            "When the context budget warning appears, save the state needed to continue before finishing the turn.",
          ],
          parameters: Type.Object({
            text: Type.String({ description: "Note text to append (plain text, bounded)." }),
          }),
          execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
            const text = requireBoundedText(params.text, NOTES_MAX_WRITE_CHARS, "text");
            const filePath = notesPath(ctx);
            const result = await enqueueWrite(filePath, async () => {
              const existing = await readNotesFile(filePath);
              const line = `- ${new Date(now()).toISOString()}: ${text}`;
              const next = appendNote(existing, line);
              if (next.length > NOTES_MAX_FILE_CHARS) {
                throw new Error(
                  `Notes file is full (${NOTES_MAX_FILE_CHARS} characters). Consolidate it with notes_write, then append again.`,
                );
              }
              await writeNotesFile(filePath, next);
              return { chars: next.length };
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Note appended (${result.chars}/${NOTES_MAX_FILE_CHARS} characters used).`,
                },
              ],
              details: { chars: result.chars },
            };
          },
        }),
      );

      pi.registerTool(
        defineTool({
          name: "notes_write",
          label: "Notes write",
          description:
            "Replace this session's persistent notes file. Use it to consolidate notes before they exceed the file bound.",
          promptSnippet: "replace the durable notes file",
          parameters: Type.Object({
            text: Type.String({ description: "Full replacement notes content (plain text, bounded)." }),
          }),
          execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
            const text = requireBoundedText(params.text, NOTES_MAX_WRITE_CHARS, "text");
            const filePath = notesPath(ctx);
            await enqueueWrite(filePath, async () => {
              await writeNotesFile(filePath, `${text}\n`);
            });
            return {
              content: [{ type: "text", text: `Notes replaced (${text.length} characters).` }],
              details: { chars: text.length },
            };
          },
        }),
      );

      pi.registerTool(
        defineTool({
          name: "notes_read",
          label: "Notes read",
          description: "Read this session's persistent notes file.",
          promptSnippet: "read the durable notes file",
          parameters: Type.Object({}),
          execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
            const filePath = notesPath(ctx);
            const content = await readNotesFile(filePath);
            return {
              content: [
                {
                  type: "text",
                  text: content ?? "(The notes file is empty or does not exist yet.)",
                },
              ],
              details: { chars: content?.length ?? 0 },
            };
          },
        }),
      );

      pi.registerTool(
        defineTool({
          name: "history_search",
          label: "History search",
          description:
            "Search this session's active-branch transcript (including messages dropped from model context by compaction) for a case-insensitive substring. Returns bounded snippets with entry ids for history_read.",
          promptSnippet: "search the full session transcript",
          promptGuidelines: [
            "When you need details from earlier in the session that compaction may have summarized, use history_search and history_read instead of asking the owner to repeat them.",
          ],
          parameters: Type.Object({
            query: Type.String({ description: "Case-insensitive substring to find." }),
          }),
          execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
            const query = params.query.trim();
            if (query === "") {
              throw new Error("query must not be empty.");
            }
            const matches = searchBranch(ctx.sessionManager.getBranch(), query);
            if (matches.length === 0) {
              return {
                content: [{ type: "text", text: `No active-branch entries match "${query}".` }],
                details: { matches: 0, truncated: false },
              };
            }
            const shown = matches.slice(0, HISTORY_MAX_MATCHES);
            const truncated = matches.length > shown.length;
            const lines = shown.map(
              (match) =>
                `[${match.entryId}] (${match.kind}, ${match.timestamp}) ${match.snippet}`,
            );
            if (truncated) {
              lines.push(`… ${matches.length - shown.length} more matches not shown.`);
            }
            return {
              content: [{ type: "text", text: lines.join("\n") }],
              details: { matches: matches.length, truncated },
            };
          },
        }),
      );

      // Pho cutover hook: when the session has notes, replace Pi's summarizer
      // with a bounded digest of them (no provider request). Empty notes
      // decline, so Pi's default summarizer runs unchanged. Applies to every
      // trigger reason and every provider on this adapter.
      pi.on("session_before_compact", async (event, ctx) => {
        const notes = await readNotesFile(notesPath(ctx));
        const digest = buildCutoverDigest(notes);
        if (digest === undefined) {
          return undefined;
        }
        return {
          compaction: {
            summary: digest,
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
            details: { kind: "pho-cutover" },
          },
        };
      });

      if (options.cutoverSignal) {
        const signal = options.cutoverSignal;
        pi.registerTool(
          defineTool({
            name: "new_context",
            label: "New context",
            description:
              "Request a context cutover: after this turn ends, the current context is replaced with your notes digest and recent messages. Earlier work leaves model context but stays searchable with history_search.",
            promptSnippet: "start a fresh context built from your notes",
            promptGuidelines: [
              "Before calling new_context, make sure notes_append/notes_write capture everything needed to continue; the cutover replaces the context with the notes digest.",
            ],
            parameters: Type.Object({}),
            execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
              signal.request(contextCutoverKey(ctx.cwd, ctx.sessionManager.getSessionId()));
              return {
                content: [
                  {
                    type: "text",
                    text:
                      "Context cutover requested. Before this turn ends, save everything needed to continue with notes_append or notes_write; after the turn settles, the context is replaced with your notes digest.",
                  },
                ],
                details: { requested: true },
              };
            },
          }),
        );
      }

      pi.registerTool(
        defineTool({
          name: "history_read",
          label: "History read",
          description:
            "Read one active-branch transcript entry by id (from history_search). Bounded; truncated content is flagged.",
          promptSnippet: "read one transcript entry by id",
          parameters: Type.Object({
            entryId: Type.String({ description: "Entry id returned by history_search." }),
          }),
          execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
            const entryId = params.entryId.trim();
            const entry = ctx.sessionManager
              .getBranch()
              .find((candidate) => candidate.id === entryId);
            if (!entry) {
              throw new Error(`No active-branch entry with id "${entryId}".`);
            }
            const text = entryText(entry);
            if (text === undefined) {
              return {
                content: [
                  { type: "text", text: `Entry ${entryId} (${entry.type}) has no text content.` },
                ],
                details: { truncated: false, chars: 0 },
              };
            }
            const truncated = text.length > HISTORY_READ_MAX_CHARS;
            return {
              content: [
                {
                  type: "text",
                  text: truncated ? `${text.slice(0, HISTORY_READ_MAX_CHARS)}\n… [truncated]` : text,
                },
              ],
              details: { truncated, chars: text.length },
            };
          },
        }),
      );
    },
  };
}

/** Tightest matching band: 8% remaining announces the 10 band, not 50. */
function budgetBand(remainingPercent: number): number | undefined {
  let matched: number | undefined;
  for (const band of CONTEXT_BUDGET_BANDS) {
    if (remainingPercent <= band) {
      matched = band;
    }
  }
  return matched;
}

function budgetLine(band: number, tokens: number, contextWindow: number): string {
  const remainingTokens = Math.max(0, contextWindow - tokens);
  return (
    `[Context budget: about ${band}% of the context window remains ` +
    `(~${remainingTokens.toLocaleString("en-US")} of ${contextWindow.toLocaleString("en-US")} tokens). ` +
    `Before continuing, save any state needed to resume with notes_append.]`
  );
}

const CUTOVER_DIGEST_HEADER =
  "[Pho context cutover] Earlier work left the model context. The durable state is the notes digest below; the full transcript stays searchable with history_search and history_read.";

/**
 * Build the cutover digest from the raw notes file. Returns undefined when
 * the notes carry no content beyond the header, so the caller declines and
 * Pi's default summarizer runs.
 */
export function buildCutoverDigest(notes: string | undefined): string | undefined {
  if (notes === undefined) {
    return undefined;
  }
  const body = notes.replace(/^# Session notes\s*/u, "").trim();
  if (body === "") {
    return undefined;
  }
  const bounded = body.slice(0, CUTOVER_DIGEST_MAX_CHARS);
  return `${CUTOVER_DIGEST_HEADER}\n\n## Session notes digest\n\n${bounded}`;
}

function requireBoundedText(text: string, maxChars: number, field: string): string {
  const trimmed = text.trim();
  if (trimmed === "") {
    throw new Error(`${field} must not be empty.`);
  }
  if (text.length > maxChars) {
    throw new Error(`${field} is ${text.length} characters; the per-call bound is ${maxChars}. Split it into smaller pieces.`);
  }
  return text;
}

const NOTES_HEADER = "# Session notes\n";

async function readNotesFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function appendNote(existing: string | undefined, line: string): string {
  const base = existing ?? NOTES_HEADER;
  const separator = base.endsWith("\n") || base === "" ? "" : "\n";
  return `${base}${separator}${line}\n`;
}

async function writeNotesFile(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, filePath);
}

interface BranchMatch {
  entryId: string;
  kind: string;
  timestamp: string;
  snippet: string;
}

function searchBranch(branch: readonly SessionEntry[], query: string): BranchMatch[] {
  const needle = query.toLowerCase();
  const matches: BranchMatch[] = [];
  for (const entry of branch) {
    const text = entryText(entry);
    if (text === undefined) {
      continue;
    }
    const index = text.toLowerCase().indexOf(needle);
    if (index < 0) {
      continue;
    }
    matches.push({
      entryId: entry.id,
      kind: entryKind(entry),
      timestamp: entry.timestamp,
      snippet: snippetAround(text, index, query.length),
    });
  }
  return matches;
}

function snippetAround(text: string, index: number, length: number): string {
  const half = Math.floor((HISTORY_SNIPPET_CHARS - length) / 2);
  const start = Math.max(0, index - half);
  const end = Math.min(text.length, index + length + half);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).replace(/\s+/gu, " ").trim()}${suffix}`;
}

function entryKind(entry: SessionEntry): string {
  if (entry.type === "message") {
    const role = (entry.message as { role?: unknown }).role;
    return typeof role === "string" ? role : "message";
  }
  return entry.type;
}

/** Flatten an entry's model-visible text; undefined for non-text entries. */
function entryText(entry: SessionEntry): string | undefined {
  if (entry.type === "compaction") {
    return `[compaction summary]\n${entry.summary}`;
  }
  if (entry.type === "branch_summary") {
    return `[branch summary]\n${entry.summary}`;
  }
  if (entry.type !== "message") {
    return undefined;
  }
  const message = entry.message as {
    role?: unknown;
    content?: unknown;
  };
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const block = part as { type?: unknown; text?: unknown; thinking?: unknown };
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      parts.push(block.thinking);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}
