import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CONTEXT_CONTINUITY_FEATURE_ID,
  CONTEXT_CONTINUITY_FEATURE_VERSION,
  CUTOVER_DIGEST_MAX_CHARS,
  ContextCutoverSignal,
  HISTORY_MAX_MATCHES,
  HISTORY_READ_MAX_CHARS,
  NOTES_MAX_FILE_CHARS,
  NOTES_MAX_WRITE_CHARS,
  buildCutoverDigest,
  contextCutoverKey,
  createContextContinuityFeature,
  sessionNotesPath,
} from "../src/context-continuity-feature";

interface Captured {
  contextHandlers: Array<(event: unknown, ctx: unknown) => unknown>;
  beforeCompactHandlers: Array<(event: unknown, ctx: unknown) => unknown>;
  tools: Map<string, { execute: (...args: never[]) => Promise<unknown>; definition: unknown }>;
}

function capture(featureOptions: Parameters<typeof createContextContinuityFeature>[0] = {}) {
  const feature = createContextContinuityFeature(featureOptions);
  const captured: Captured = { contextHandlers: [], beforeCompactHandlers: [], tools: new Map() };
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      if (event === "context") {
        captured.contextHandlers.push(handler);
      }
      if (event === "session_before_compact") {
        captured.beforeCompactHandlers.push(handler);
      }
    },
    registerTool(definition: { name: string; execute: (...args: never[]) => Promise<unknown> }) {
      captured.tools.set(definition.name, { execute: definition.execute, definition });
    },
  };
  feature.extensionFactories?.[0]?.factory(pi as never);
  return { feature, captured };
}

function fakeCtx(options: {
  sessionDir?: string;
  sessionId?: string;
  percent?: number | null;
  tokens?: number | null;
  contextWindow?: number;
  branch?: unknown[];
}) {
  return {
    cwd: "/tmp/ws",
    sessionManager: {
      getSessionDir: () => options.sessionDir ?? "/tmp/sessions",
      getSessionId: () => options.sessionId ?? "s1",
      getBranch: () => options.branch ?? [],
    },
    getContextUsage: () =>
      options.percent === undefined
        ? undefined
        : {
            tokens: options.tokens ?? null,
            contextWindow: options.contextWindow ?? 100_000,
            percent: options.percent,
          },
  };
}

function messageEntry(id: string, role: string, text: string) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-09-01T00:00:00.000Z",
    message: { role, content: [{ type: "text", text }], timestamp: 0 },
  };
}

async function callTool(
  captured: Captured,
  name: string,
  params: Record<string, unknown>,
  ctx: unknown,
): Promise<{ content: { type: string; text?: string }[]; details: Record<string, unknown> }> {
  const tool = captured.tools.get(name);
  expect(tool).toBeDefined();
  return (await tool!.execute(
    "call-1" as never,
    params as never,
    undefined as never,
    undefined as never,
    ctx as never,
  )) as { content: { type: string; text?: string }[]; details: Record<string, unknown> };
}

describe("context continuity feature", () => {
  test("has a stable manifest identity and one inline extension", () => {
    const { feature, captured } = capture();
    expect(feature.id).toBe(CONTEXT_CONTINUITY_FEATURE_ID);
    expect(feature.version).toBe(CONTEXT_CONTINUITY_FEATURE_VERSION);
    expect(feature.expected).toEqual({ extensions: 1 });
    expect(captured.contextHandlers).toHaveLength(1);
    expect(captured.beforeCompactHandlers).toHaveLength(1);
    expect([...captured.tools.keys()].sort()).toEqual([
      "history_read",
      "history_search",
      "notes_append",
      "notes_read",
      "notes_write",
    ]);
  });

  test("new_context is registered only when a cutover signal is wired", () => {
    const withoutSignal = capture();
    expect(withoutSignal.captured.tools.has("new_context")).toBe(false);

    const withSignal = capture({ cutoverSignal: new ContextCutoverSignal() });
    expect(withSignal.captured.tools.has("new_context")).toBe(true);
  });

  test("the notes sidecar keys on the session id beside the Pi JSONL", () => {
    expect(sessionNotesPath("/tmp/sessions", "abc")).toBe("/tmp/sessions/abc.notes.md");
  });

  describe("budget injector", () => {
    const eventWith = (text: string) => ({
      type: "context",
      messages: [{ role: "user", content: [{ type: "text", text }], timestamp: 0 }],
    });

    test("injects one ephemeral line per band crossing and never mutates the request", async () => {
      const { captured } = capture();
      const handler = captured.contextHandlers[0]!;
      const event = eventWith("hello");

      const first = (await handler(event, fakeCtx({ percent: 55, tokens: 55_000 }))) as {
        messages: { role: string; content: { text: string }[] }[];
      };
      expect(first.messages).toHaveLength(2);
      const line = first.messages[1]!;
      expect(line.role).toBe("user");
      expect(line.content[0]!.text).toContain("about 50% of the context window remains");
      expect(line.content[0]!.text).toContain("notes_append");
      // The original request array is untouched; the line rides the copy.
      expect(event.messages).toHaveLength(1);

      // Same band on the next request: no repeat.
      const repeat = await handler(eventWith("again"), fakeCtx({ percent: 60, tokens: 60_000 }));
      expect(repeat).toBeUndefined();
    });

    test("announces tighter bands as remaining drops and re-announces after recovery", async () => {
      const { captured } = capture();
      const handler = captured.contextHandlers[0]!;

      const at50 = (await handler(
        eventWith("a"),
        fakeCtx({ percent: 51, tokens: 51_000 }),
      )) as { messages: { content: { text: string }[] }[] };
      expect(at50.messages[1]!.content[0]!.text).toContain("about 50%");

      const at25 = (await handler(
        eventWith("b"),
        fakeCtx({ percent: 80, tokens: 80_000 }),
      )) as { messages: { content: { text: string }[] }[] };
      expect(at25.messages[1]!.content[0]!.text).toContain("about 25%");

      const at10 = (await handler(
        eventWith("c"),
        fakeCtx({ percent: 95, tokens: 95_000 }),
      )) as { messages: { content: { text: string }[] }[] };
      expect(at10.messages[1]!.content[0]!.text).toContain("about 10%");

      // Recovery (e.g. after a compaction) resets the band tracker.
      const recovered = await handler(eventWith("d"), fakeCtx({ percent: 20, tokens: 20_000 }));
      expect(recovered).toBeUndefined();

      const reannounced = (await handler(
        eventWith("e"),
        fakeCtx({ percent: 52, tokens: 52_000 }),
      )) as { messages: { content: { text: string }[] }[] };
      expect(reannounced.messages[1]!.content[0]!.text).toContain("about 50%");
    });

    test("stays silent when usage is unavailable or unknown", async () => {
      const { captured } = capture();
      const handler = captured.contextHandlers[0]!;
      expect(await handler(eventWith("a"), fakeCtx({}))).toBeUndefined();
      expect(await handler(eventWith("b"), fakeCtx({ percent: null, tokens: null }))).toBeUndefined();
      expect(await handler(eventWith("c"), fakeCtx({ percent: 30, tokens: 30_000 }))).toBeUndefined();
    });
  });

  describe("notes tools", () => {
    async function withTempDir(run: (dir: string) => Promise<void>) {
      const dir = await mkdtemp(path.join(tmpdir(), "pho-notes-"));
      try {
        await run(dir);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }

    test("append creates the file, persists across extension instances, and read returns it", async () => {
      await withTempDir(async (dir) => {
        const notesPathFor = ({ sessionId }: { sessionDir: string; sessionId: string }) =>
          path.join(dir, `${sessionId}.notes.md`);
        const first = capture({ notesPathFor, now: () => Date.parse("2026-09-01T01:00:00.000Z") });
        const ctx = fakeCtx({ sessionId: "s1" });

        const appended = await callTool(first.captured, "notes_append", { text: "chose SQLite" }, ctx);
        expect(appended.content[0]!.text).toContain("Note appended");

        // A fresh extension instance (restart) sees the same file.
        const second = capture({ notesPathFor });
        const read = await callTool(second.captured, "notes_read", {}, ctx);
        expect(read.content[0]!.text).toContain("# Session notes");
        expect(read.content[0]!.text).toContain("2026-09-01T01:00:00.000Z: chose SQLite");

        const onDisk = await readFile(path.join(dir, "s1.notes.md"), "utf8");
        expect(onDisk).toContain("chose SQLite");
      });
    });

    test("append rejects empty and over-long text and a full file points at notes_write", async () => {
      await withTempDir(async (dir) => {
        const notesPathFor = ({ sessionId }: { sessionDir: string; sessionId: string }) =>
          path.join(dir, `${sessionId}.notes.md`);
        const { captured } = capture({ notesPathFor });
        const ctx = fakeCtx({ sessionId: "s1" });

        await expect(callTool(captured, "notes_append", { text: "   " }, ctx)).rejects.toThrow(
          "must not be empty",
        );
        await expect(
          callTool(captured, "notes_append", { text: "x".repeat(NOTES_MAX_WRITE_CHARS + 1) }, ctx),
        ).rejects.toThrow("per-call bound");

        // Fill the file near the bound, then force the whole-file refusal.
        await writeFile(
          path.join(dir, "s1.notes.md"),
          `# Session notes\n\n${"y".repeat(NOTES_MAX_FILE_CHARS - 20)}`,
        );
        await expect(callTool(captured, "notes_append", { text: "one more note" }, ctx)).rejects.toThrow(
          "notes_write",
        );
      });
    });

    test("write replaces the file within bounds and read reports the honest empty state", async () => {
      await withTempDir(async (dir) => {
        const notesPathFor = ({ sessionId }: { sessionDir: string; sessionId: string }) =>
          path.join(dir, `${sessionId}.notes.md`);
        const { captured } = capture({ notesPathFor });
        const ctx = fakeCtx({ sessionId: "s1" });

        const empty = await callTool(captured, "notes_read", {}, ctx);
        expect(empty.content[0]!.text).toContain("empty or does not exist");

        await callTool(captured, "notes_append", { text: "old state" }, ctx);
        const written = await callTool(captured, "notes_write", { text: "consolidated state" }, ctx);
        expect(written.content[0]!.text).toContain("Notes replaced");
        const read = await callTool(captured, "notes_read", {}, ctx);
        expect(read.content[0]!.text).toBe("consolidated state\n");
        expect(read.content[0]!.text).not.toContain("old state");

        await expect(
          callTool(captured, "notes_write", { text: "x".repeat(NOTES_MAX_WRITE_CHARS + 1) }, ctx),
        ).rejects.toThrow("per-call bound");
      });
    });

    test("parallel appends serialize without losing updates", async () => {
      await withTempDir(async (dir) => {
        const notesPathFor = ({ sessionId }: { sessionDir: string; sessionId: string }) =>
          path.join(dir, `${sessionId}.notes.md`);
        const { captured } = capture({ notesPathFor });
        const ctx = fakeCtx({ sessionId: "s1" });

        await Promise.all(
          Array.from({ length: 8 }, (_, index) =>
            callTool(captured, "notes_append", { text: `note ${index}` }, ctx),
          ),
        );
        const onDisk = await readFile(path.join(dir, "s1.notes.md"), "utf8");
        for (let index = 0; index < 8; index += 1) {
          expect(onDisk).toContain(`note ${index}`);
        }
      });
    });
  });

  describe("history tools", () => {
    const branch = [
      messageEntry("m1", "user", "deploy the staging build"),
      messageEntry("m2", "assistant", "running the deploy script now"),
      {
        type: "compaction",
        id: "c1",
        parentId: "m2",
        timestamp: "2026-09-01T01:00:00.000Z",
        summary: "we discussed the staging deploy",
        firstKeptEntryId: "m3",
        tokensBefore: 10_000,
      },
      messageEntry("m3", "user", "deploy finished?"),
      { type: "custom", id: "x1", parentId: null, timestamp: "2026-09-01T02:00:00.000Z", customType: "label", data: {} },
    ];

    test("search finds user, assistant, and compaction text with bounded snippets", async () => {
      const { captured } = capture();
      const ctx = fakeCtx({ branch });
      const result = await callTool(captured, "history_search", { query: "deploy" }, ctx);
      const text = result.content[0]!.text!;
      expect(text).toContain("[m1] (user");
      expect(text).toContain("[m2] (assistant");
      expect(text).toContain("[c1] (compaction");
      expect(text).toContain("[m3] (user");
      expect(result.details).toEqual({ matches: 4, truncated: false });
      // Non-text entries never match and nothing was mutated.
      expect(text).not.toContain("[x1]");
      expect(branch).toHaveLength(5);
    });

    test("search is case-insensitive, rejects empty queries, and caps the match list", async () => {
      const many = Array.from({ length: HISTORY_MAX_MATCHES + 5 }, (_, index) =>
        messageEntry(`mm${index}`, "user", `needle hit ${index}`),
      );
      const { captured } = capture();
      const result = await callTool(captured, "history_search", { query: "NEEDLE" }, fakeCtx({ branch: many }));
      expect(result.details).toEqual({ matches: HISTORY_MAX_MATCHES + 5, truncated: true });
      expect(result.content[0]!.text).toContain("5 more matches not shown");

      await expect(
        callTool(captured, "history_search", { query: "  " }, fakeCtx({ branch: many })),
      ).rejects.toThrow("must not be empty");

      const none = await callTool(captured, "history_search", { query: "absent" }, fakeCtx({ branch }));
      expect(none.content[0]!.text).toContain("No active-branch entries match");
    });

    test("read returns one entry, truncates long text with a flag, and rejects unknown ids", async () => {
      const long = messageEntry("long1", "assistant", "z".repeat(HISTORY_READ_MAX_CHARS + 500));
      const { captured } = capture();
      const ctx = fakeCtx({ branch: [...branch, long] });

      const full = await callTool(captured, "history_read", { entryId: "m2" }, ctx);
      expect(full.content[0]!.text).toBe("running the deploy script now");
      expect(full.details).toEqual({ truncated: false, chars: "running the deploy script now".length });

      const truncated = await callTool(captured, "history_read", { entryId: "long1" }, ctx);
      expect(truncated.details.truncated).toBe(true);
      expect(truncated.content[0]!.text).toContain("[truncated]");
      expect(truncated.content[0]!.text!.length).toBeLessThanOrEqual(HISTORY_READ_MAX_CHARS + 20);

      await expect(callTool(captured, "history_read", { entryId: "missing" }, ctx)).rejects.toThrow(
        'No active-branch entry with id "missing"',
      );

      const nonText = await callTool(captured, "history_read", { entryId: "x1" }, ctx);
      expect(nonText.content[0]!.text).toContain("has no text content");
    });
  });

  describe("cutover hook", () => {
    const preparation = {
      firstKeptEntryId: "keep-1",
      tokensBefore: 12_345,
      model: { provider: "anthropic", id: "claude" },
      messages: [],
    };

    async function runHook(notesPathFor: (input: { sessionDir: string; sessionId: string }) => string) {
      const { captured } = capture({ notesPathFor });
      const handler = captured.beforeCompactHandlers[0]!;
      return handler(
        { type: "session_before_compact", preparation },
        fakeCtx({ sessionId: "s1" }),
      );
    }

    test("non-empty notes produce a bounded digest with the preparation cut point", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "pho-cutover-"));
      try {
        const notesPathFor = ({ sessionId }: { sessionDir: string; sessionId: string }) =>
          path.join(dir, `${sessionId}.notes.md`);
        await writeFile(path.join(dir, "s1.notes.md"), "# Session notes\n\n- decided SQLite\n");

        const result = (await runHook(notesPathFor)) as {
          compaction: {
            summary: string;
            firstKeptEntryId: string;
            tokensBefore: number;
            details: Record<string, unknown>;
          };
        };
        expect(result.compaction.firstKeptEntryId).toBe("keep-1");
        expect(result.compaction.tokensBefore).toBe(12_345);
        expect(result.compaction.details).toEqual({ kind: "pho-cutover" });
        expect(result.compaction.summary).toContain("Pho context cutover");
        expect(result.compaction.summary).toContain("history_search");
        expect(result.compaction.summary).toContain("- decided SQLite");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    test("missing, empty, or header-only notes decline to Pi's summarizer", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "pho-cutover-"));
      try {
        const notesPathFor = ({ sessionId }: { sessionDir: string; sessionId: string }) =>
          path.join(dir, `${sessionId}.notes.md`);

        // Missing file.
        expect(await runHook(notesPathFor)).toBeUndefined();
        // Header only.
        await writeFile(path.join(dir, "s1.notes.md"), "# Session notes\n");
        expect(await runHook(notesPathFor)).toBeUndefined();
        // Whitespace body.
        await writeFile(path.join(dir, "s1.notes.md"), "# Session notes\n\n   \n");
        expect(await runHook(notesPathFor)).toBeUndefined();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    test("the digest builder bounds over-long notes", () => {
      const huge = `# Session notes\n\n${"n".repeat(CUTOVER_DIGEST_MAX_CHARS * 2)}`;
      const digest = buildCutoverDigest(huge);
      expect(digest).toBeDefined();
      expect(digest!.length).toBeLessThan(CUTOVER_DIGEST_MAX_CHARS + 500);
      expect(buildCutoverDigest(undefined)).toBeUndefined();
      expect(buildCutoverDigest("# Session notes\n")).toBeUndefined();
    });
  });

  describe("new_context tool", () => {
    test("execute records a per-session request the host consumes once", async () => {
      const signal = new ContextCutoverSignal();
      const { captured } = capture({ cutoverSignal: signal });
      const ctx = fakeCtx({ sessionId: "s1" });
      const key = contextCutoverKey("/tmp/ws", "s1");

      const result = await callTool(captured, "new_context", {}, ctx);
      expect(result.content[0]!.text).toContain("notes_append");
      expect(result.details).toEqual({ requested: true });

      expect(signal.consume(key)).toBe(true);
      // Consumed once; a second consume or a different session sees nothing.
      expect(signal.consume(key)).toBe(false);
      expect(signal.consume(contextCutoverKey("/tmp/ws", "s2"))).toBe(false);
    });

    test("drop clears a request without consuming it", async () => {
      const signal = new ContextCutoverSignal();
      const { captured } = capture({ cutoverSignal: signal });
      const key = contextCutoverKey("/tmp/ws", "s1");

      await callTool(captured, "new_context", {}, fakeCtx({ sessionId: "s1" }));
      signal.drop(key);
      expect(signal.consume(key)).toBe(false);
    });
  });
});
