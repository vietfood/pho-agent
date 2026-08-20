import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRuntimeEvent } from "@pho-agent/protocol";
import { createAgentRuntime, listProductAgentSessions, type AgentProductAdapter } from "../src";
import { createDeterministicAgentProvider } from "../src/testing";

async function fixture(): Promise<{ agentDir: string; product: AgentProductAdapter }> {
  const root = await mkdtemp(path.join(tmpdir(), "pho-agent-m0-"));
  const agentDir = path.join(root, "agent");
  const runtimeDirectory = path.join(root, "opaque-scope-data");
  await Promise.all([mkdir(agentDir), mkdir(runtimeDirectory)]);
  return {
    agentDir,
    product: {
      id: "non-code-fixture",
      scope: {
        resolve(scopeId) {
          if (scopeId !== "memory:case-1") throw new Error("Unknown opaque scope.");
          return { runtimeDirectory };
        },
      },
    features: [],
      evidenceProviders: [],
      verificationAdapters: [],
    },
  };
}

async function waitFor(events: AgentRuntimeEvent[], type: AgentRuntimeEvent["type"]): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!events.some((event) => event.type === type)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${type}.`);
    await Bun.sleep(10);
  }
}

describe("headless non-code consumer", () => {
  test("creates, prompts, settles, reopens, and persists an opaque scope", async () => {
    const { agentDir, product } = await fixture();
    const events: AgentRuntimeEvent[] = [];
    const first = await createAgentRuntime({
      agentDir,
      product,
      testProvider: createDeterministicAgentProvider(),
      systemPrompt: "You are a deterministic non-code fixture.",
    });
    const stop = first.subscribe((event) => events.push(event));
    const created = await first.createSession("memory:case-1");
    const admission = await first.sendPrompt({ ...created.key, text: "hello" });
    expect(admission.admitted).toBe(true);
    await waitFor(events, "run_settled");
    const settled = await first.getSessionSnapshot(created.key);
    expect(settled.messages.some((message) => message.role === "user")).toBe(true);
    expect(settled.messages.flatMap((message) => message.blocks).some((block) => block.type === "text" && block.text === "Headless response.")).toBe(true);
    stop();
    await first.dispose();

    const second = await createAgentRuntime({
      agentDir,
      product,
      testProvider: createDeterministicAgentProvider(),
      systemPrompt: "You are a deterministic non-code fixture.",
    });
    try {
      expect(await listProductAgentSessions(product, agentDir, "memory:case-1")).toContain(created.key.sessionId);
      const reopened = await second.openSession(created.key);
      expect(reopened.messages.some((message) => message.role === "assistant")).toBe(true);
    } finally {
      await second.dispose();
    }
  }, 20_000);

  test("aborts a run and admits a later prompt", async () => {
    const { agentDir, product } = await fixture();
    const runtime = await createAgentRuntime({
      agentDir,
      product,
      testProvider: createDeterministicAgentProvider(),
    });
    try {
      const created = await runtime.createSession("memory:case-1");
      const admission = await runtime.sendPrompt({ ...created.key, text: "interrupt me" });
      await runtime.abortRun({ ...created.key, runId: admission.runId });
      const next = await runtime.sendPrompt({ ...created.key, text: "continue" });
      expect(next.admitted).toBe(true);
    } finally {
      await runtime.dispose();
    }
  }, 20_000);
});
