import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  MAX_SESSION_TITLE_SEED_CHARS,
  compactSessionText,
  parseGeneratedSessionTitle,
} from "@pho-agent/protocol";

const TITLE_TIMEOUT_MS = 20_000;
const TITLE_SYSTEM_PROMPT = [
  "You name coding-assistant sessions.",
  "Write 3 to 8 words that state the user's goal.",
  "Match the user's language.",
  "No quotes, labels, markdown, or trailing punctuation.",
].join(" ");

export async function generateSessionTitle(
  source: AgentSession,
  seed: string,
  options: { signal?: AbortSignal } = {},
): Promise<string | undefined> {
  const trimmed = compactSessionText(seed, MAX_SESSION_TITLE_SEED_CHARS);
  const model = source.agent.state.model;
  if (!trimmed || !model || options.signal?.aborted) {
    return undefined;
  }

  const sourceAgent = source.agent;
  const titleAgent = new Agent({
    initialState: {
      systemPrompt: TITLE_SYSTEM_PROMPT,
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
  const abortTitle = () => {
    titleAgent.abort();
  };
  options.signal?.addEventListener("abort", abortTitle, { once: true });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      titleAgent.prompt(
        `Generate a short session title for this request.\nReturn only the title.\n\n<request>\n${trimmed}\n</request>`,
      ),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          titleAgent.abort();
          reject(new Error("Session title generation timed out"));
        }, TITLE_TIMEOUT_MS);
      }),
    ]);
    return readGeneratedTitle(titleAgent);
  } catch {
    titleAgent.abort();
    await titleAgent.waitForIdle().catch(() => undefined);
    return undefined;
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    options.signal?.removeEventListener("abort", abortTitle);
  }
}

function readGeneratedTitle(agent: Agent): string | undefined {
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
    if (!text) {
      continue;
    }
    return parseGeneratedSessionTitle(text);
  }
  return undefined;
}
