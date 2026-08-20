import { agentScopeKeyId, createHarnessError, HARNESS_ERROR_CODES, type AgentScopeKey } from "@pho-agent/protocol";

export type { AgentScopeKey } from "@pho-agent/protocol";

export const MAX_RESIDENT_SESSION_CONTROLLERS = 8;
export const MAX_CONCURRENT_ACTIVE_RUNS = 4;

export interface SessionRegistryHost<C> {
  openController(key: AgentScopeKey): Promise<C>;
  createController(scopeId: string): Promise<C>;
  keyOf(controller: C): AgentScopeKey;
  isProtected(controller: C): boolean;
  lastSelectedAt(controller: C): number;
  markSelected(controller: C, at: number): void;
  hasActiveRun(controller: C): boolean;
  dispose(controller: C, reason: "evicted" | "removed" | "shutdown"): Promise<void>;
}

export interface SessionRegistry<C> {
  open(key: AgentScopeKey): Promise<C>;
  create(scopeId: string): Promise<C>;
  select(key: AgentScopeKey, at?: number): C;
  get(key: AgentScopeKey): C | undefined;
  list(): C[];
  activeRunCount(): number;
  assertCanAdmitRun(operation: string): void;
  runLocked<T>(key: AgentScopeKey, operation: () => Promise<T>): Promise<T>;
  evictUnprotected(except?: AgentScopeKey): Promise<void>;
  remove(key: AgentScopeKey): Promise<C | undefined>;
  disposeAll(): Promise<void>;
}

export function createSessionRegistry<C>(host: SessionRegistryHost<C>): SessionRegistry<C> {
  const controllers = new Map<string, C>();
  const opening = new Map<string, Promise<C>>();
  const locks = new Map<string, Promise<void>>();
  let disposingAll = false;

  function requireKey(key: AgentScopeKey, operation: string): string {
    if (typeof key.scopeId !== "string" || key.scopeId.trim() === "") {
      throw createHarnessError({
        code: HARNESS_ERROR_CODES.invalidCommand,
        message: `${operation} requires scopeId.`,
        operation,
        recoverable: true,
      });
    }
    if (typeof key.sessionId !== "string" || key.sessionId.trim() === "") {
      throw createHarnessError({
        code: HARNESS_ERROR_CODES.invalidCommand,
        message: `${operation} requires sessionId.`,
        operation,
        recoverable: true,
      });
    }
    return agentScopeKeyId(key);
  }

  function getById(id: string): C | undefined {
    return controllers.get(id);
  }

  async function evictIfNeeded(operation: string): Promise<void> {
    if (controllers.size < MAX_RESIDENT_SESSION_CONTROLLERS) {
      return;
    }
    const idle = [...controllers.values()]
      .filter((controller) => !host.isProtected(controller))
      .sort((left, right) => host.lastSelectedAt(left) - host.lastSelectedAt(right));
    const victim = idle[0];
    if (!victim) {
      throw createHarnessError({
        code: HARNESS_ERROR_CODES.sessionConcurrencyLimit,
        message: `At most ${MAX_RESIDENT_SESSION_CONTROLLERS} chats can stay open. Stop or close a running chat first.`,
        operation,
        recoverable: true,
      });
    }
    const victimKey = host.keyOf(victim);
    controllers.delete(agentScopeKeyId(victimKey));
    await host.dispose(victim, "evicted");
  }

  const registry: SessionRegistry<C> = {
    async open(key) {
      const id = requireKey(key, "openSession");
      const existing = getById(id);
      if (existing) {
        return existing;
      }
      const inflight = opening.get(id);
      if (inflight) {
        return inflight;
      }
      const pending = (async () => {
        await evictIfNeeded("openSession");
        const created = await host.openController(key);
        const createdId = requireKey(host.keyOf(created), "openSession");
        controllers.set(createdId, created);
        return created;
      })();
      opening.set(id, pending);
      try {
        return await pending;
      } finally {
        if (opening.get(id) === pending) {
          opening.delete(id);
        }
      }
    },
    async create(scopeId) {
      await evictIfNeeded("createSession");
      const created = await host.createController(scopeId);
      const createdId = requireKey(host.keyOf(created), "createSession");
      controllers.set(createdId, created);
      return created;
    },
    select(key, at = Date.now()) {
      const id = requireKey(key, "selectSession");
      const controller = getById(id);
      if (!controller) {
        throw createHarnessError({
          code: HARNESS_ERROR_CODES.sessionNotFound,
          message: "The selected session is not open.",
          operation: "selectSession",
          recoverable: true,
        });
      }
      host.markSelected(controller, at);
      return controller;
    },
    get(key) {
      return getById(agentScopeKeyId(key));
    },
    list() {
      return [...controllers.values()];
    },
    activeRunCount() {
      return [...controllers.values()].filter((controller) => host.hasActiveRun(controller)).length;
    },
    assertCanAdmitRun(operation) {
      if (registry.activeRunCount() >= MAX_CONCURRENT_ACTIVE_RUNS) {
        throw createHarnessError({
          code: HARNESS_ERROR_CODES.sessionConcurrencyLimit,
          message: `At most ${MAX_CONCURRENT_ACTIVE_RUNS} chats can run at once.`,
          operation,
          recoverable: true,
        });
      }
    },
    async runLocked(key, operation) {
      const id = requireKey(key, "sessionLifecycle");
      const previous = locks.get(id) ?? Promise.resolve();
      let release: () => void = () => undefined;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      locks.set(id, previous.then(() => current));
      await previous;
      try {
        return await operation();
      } finally {
        release();
        if (locks.get(id) === current) {
          locks.delete(id);
        }
      }
    },
    async evictUnprotected(except) {
      const exceptId = except ? requireKey(except, "refreshSkills") : undefined;
      const victims = [...controllers.values()].filter((controller) => {
        if (host.isProtected(controller)) {
          return false;
        }
        return exceptId === undefined || agentScopeKeyId(host.keyOf(controller)) !== exceptId;
      });
      for (const victim of victims) {
        const victimKey = host.keyOf(victim);
        controllers.delete(agentScopeKeyId(victimKey));
        await host.dispose(victim, "evicted");
      }
    },
    async remove(key) {
      const id = requireKey(key, "removeSession");
      const controller = controllers.get(id);
      if (!controller) {
        return undefined;
      }
      controllers.delete(id);
      await host.dispose(controller, "removed");
      return controller;
    },
    async disposeAll() {
      if (disposingAll) {
        return;
      }
      disposingAll = true;
      const snapshot = [...controllers.values()];
      controllers.clear();
      opening.clear();
      await Promise.all(snapshot.map((controller) => host.dispose(controller, "shutdown")));
    },
  };

  return registry;
}
