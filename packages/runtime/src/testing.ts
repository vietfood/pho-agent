import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  type Context,
  type FauxProviderHandle,
} from "@earendil-works/pi-ai";

export {
  Type,
  createProvider,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai";
export type {
  AuthInteraction,
  Context,
  FauxProviderHandle,
  OAuthCredential,
  Provider,
} from "@earendil-works/pi-ai";
export { defineTool } from "@earendil-works/pi-coding-agent";
export type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export function createDeterministicAgentProvider(): FauxProviderHandle {
  const faux = fauxProvider({
    provider: "pho-agent-test",
    api: "pho-agent-test-api",
    models: [{
      id: "headless",
      name: "Pho Agent headless test",
      reasoning: false,
      input: ["text"],
      contextWindow: 16_000,
      maxTokens: 1_024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    tokensPerSecond: 200,
  });
  const respond = (_context: Context) => {
    faux.appendResponses([respond]);
    return fauxAssistantMessage(fauxText("Headless response."));
  };
  faux.setResponses([respond]);
  return faux;
}
