import type { AgentBackendAdapter } from "@pho-agent/host";
import type { AgentBackendDescriptor } from "@pho-agent/protocol";
import { createAgentRuntime, type CreateAgentRuntimeOptions } from "./runtime";

export const PI_BACKEND_DESCRIPTOR: AgentBackendDescriptor = {
  id: "pi",
  label: "Pi",
  capabilities: {
    steering: "native",
    "queued-follow-up": "native",
  },
};

export async function createPiAgentBackend(
  options: CreateAgentRuntimeOptions,
): Promise<AgentBackendAdapter> {
  return {
    descriptor: PI_BACKEND_DESCRIPTOR,
    ...await createAgentRuntime(options),
  };
}
