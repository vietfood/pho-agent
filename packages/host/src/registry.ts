import {
  normalizeAgentBackendDescriptor,
  requireAgentId,
  type AgentBackendDescriptor,
} from "@pho-agent/protocol";

export interface AgentBackendRegistration {
  descriptor: AgentBackendDescriptor;
  dispose(): Promise<void>;
}

export interface AgentBackendRegistryEntry<T extends AgentBackendRegistration> {
  adapter: T;
  descriptor: AgentBackendDescriptor;
}

export interface AgentBackendRegistry<T extends AgentBackendRegistration> {
  list(): readonly AgentBackendRegistryEntry<T>[];
  listDescriptors(): readonly AgentBackendDescriptor[];
  resolve(backendId: string): AgentBackendRegistryEntry<T>;
  dispose(): Promise<void>;
}

export function createAgentBackendRegistry<T extends AgentBackendRegistration>(
  adapters: readonly T[],
): AgentBackendRegistry<T> {
  const entries: AgentBackendRegistryEntry<T>[] = [];
  const byId = new Map<string, AgentBackendRegistryEntry<T>>();
  let disposed = false;

  for (const adapter of adapters) {
    const descriptor = normalizeAgentBackendDescriptor(adapter.descriptor);
    if (byId.has(descriptor.id)) throw new Error(`Duplicate agent backend: ${descriptor.id}.`);
    const entry = { adapter, descriptor };
    entries.push(entry);
    byId.set(descriptor.id, entry);
  }

  function requireAvailable(): void {
    if (disposed) throw new Error("The agent backend registry is disposed.");
  }

  return {
    list() {
      requireAvailable();
      return [...entries];
    },
    listDescriptors() {
      requireAvailable();
      return entries.map(({ adapter, descriptor }) => {
        const current = normalizeAgentBackendDescriptor(adapter.descriptor);
        if (current.id !== descriptor.id) throw new Error("An agent backend cannot change its id after registration.");
        return current;
      });
    },
    resolve(backendId) {
      requireAvailable();
      const id = requireAgentId(backendId, "backendId");
      const entry = byId.get(id);
      if (!entry) throw new Error(`Unknown agent backend: ${id}.`);
      const descriptor = normalizeAgentBackendDescriptor(entry.adapter.descriptor);
      if (descriptor.id !== entry.descriptor.id) throw new Error("An agent backend cannot change its id after registration.");
      return { ...entry, descriptor };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await Promise.all(entries.map(({ adapter }) => adapter.dispose()));
      entries.length = 0;
      byId.clear();
    },
  };
}
