import path from "node:path";
import { mkdirSync } from "node:fs";
import type { FauxProviderHandle } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  ModelRuntime,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  hasTrustRequiringProjectResources,
  type AgentSessionRuntime,
  type CreateAgentSessionFromServicesOptions,
  type CreateAgentSessionRuntimeFactory,
  type ModelRuntime as PiModelRuntime,
  type ResourceLoader,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";

type AgentResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

export type AgentModelRuntime = PiModelRuntime;
export type AgentSessionInfo = SessionInfo;
export type AgentSessionFactory = CreateAgentSessionRuntimeFactory;
export type AgentManagedSession = AgentSessionRuntime;
export type AgentResourceLoader = ResourceLoader | DefaultResourceLoader;

export interface AgentPiSessionFactoryOptions {
  modelRuntime: AgentModelRuntime;
  resourceLoaderOptions: () => Omit<AgentResourceLoaderOptions, "cwd" | "agentDir" | "settingsManager">;
  resolveProjectTrust?: (cwd: string) => boolean | Promise<boolean>;
  settingsManager?: (cwd: string, agentDir: string) => SettingsManager | undefined;
  sessionOptions?: () => Pick<
    CreateAgentSessionFromServicesOptions,
    "customTools" | "model" | "thinkingLevel" | "tools"
  >;
}

export async function createAgentModelRuntime(agentDir: string): Promise<AgentModelRuntime> {
  return ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
}

export function createAgentProjectTrustStore(agentDir: string): ProjectTrustStore {
  return new ProjectTrustStore(agentDir);
}

export function agentProjectRequiresTrust(...args: Parameters<typeof hasTrustRequiringProjectResources>): boolean {
  return hasTrustRequiringProjectResources(...args);
}

export function createAgentSettingsManager(cwd: string, agentDir: string): SettingsManager {
  return SettingsManager.create(cwd, agentDir);
}

export function createInMemoryAgentSettings(
  settings: Parameters<typeof SettingsManager.inMemory>[0],
): SettingsManager {
  return SettingsManager.inMemory(settings);
}

export async function createAgentResourceLoader(
  options: AgentResourceLoaderOptions,
  reloadOptions?: Parameters<DefaultResourceLoader["reload"]>[0],
): Promise<DefaultResourceLoader> {
  const loader = new DefaultResourceLoader(options);
  await loader.reload(reloadOptions);
  return loader;
}

export function createPiSessionRuntimeFactory(options: AgentPiSessionFactoryOptions): AgentSessionFactory {
  return async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const settingsManager = options.settingsManager?.(cwd, agentDir);
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      modelRuntime: options.modelRuntime,
      ...(settingsManager ? { settingsManager } : {}),
      resourceLoaderOptions: options.resourceLoaderOptions(),
      ...(options.resolveProjectTrust
        ? {
            resourceLoaderReloadOptions: {
              resolveProjectTrust: async () => options.resolveProjectTrust!(cwd),
            },
          }
        : {}),
    });
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        ...options.sessionOptions?.(),
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };
}

export function createNewAgentSessionRuntime(
  factory: AgentSessionFactory,
  input: { cwd: string; agentDir: string },
): Promise<AgentManagedSession> {
  return createAgentSessionRuntime(factory, {
    ...input,
    sessionManager: SessionManager.create(input.cwd, agentSessionDirectory(input.agentDir, input.cwd)),
  });
}

export async function openAgentSessionRuntime(
  factory: AgentSessionFactory,
  input: { cwd: string; agentDir: string; sessionId: string },
): Promise<AgentManagedSession | undefined> {
  const sessionDir = agentSessionDirectory(input.agentDir, input.cwd);
  const info = (await SessionManager.list(input.cwd, sessionDir)).find((entry) => entry.id === input.sessionId);
  if (!info) {
    return undefined;
  }
  return createAgentSessionRuntime(factory, {
    cwd: input.cwd,
    agentDir: input.agentDir,
    sessionManager: SessionManager.open(info.path, sessionDir),
  });
}

export function listAgentSessions(cwd: string, agentDir: string): Promise<AgentSessionInfo[]> {
  return SessionManager.list(cwd, agentSessionDirectory(agentDir, cwd));
}

export function registerAgentTestProvider(
  runtime: AgentModelRuntime,
  handle: FauxProviderHandle,
): void {
  runtime.registerNativeProvider(handle.provider);
}

function agentSessionDirectory(agentDir: string, cwd: string): string {
  const safePath = `--${path.resolve(cwd).replace(/^[/\\]/u, "").replace(/[/\\:]/gu, "-")}--`;
  const directory = path.join(path.resolve(agentDir), "sessions", safePath);
  mkdirSync(directory, { recursive: true });
  return directory;
}
