import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientConnection,
  type ClientContext,
  type InitializeResponse,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import type { Unsubscribe } from "@pho-agent/protocol";

export interface AcpClient {
  initialize(): Promise<InitializeResponse>;
  createSession(cwd: string): Promise<string>;
  openSession(sessionId: string, cwd: string): Promise<void>;
  prompt(sessionId: string, text: string): Promise<PromptResponse>;
  cancel(sessionId: string): Promise<void>;
  setPermissionHandler(
    handler: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>,
  ): Unsubscribe;
  subscribe(listener: (notification: SessionNotification) => void): Unsubscribe;
  dispose(): Promise<void>;
}

export interface CreateAcpStdioClientOptions {
  command: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

export function createAcpStdioClient(options: CreateAcpStdioClientOptions): AcpClient {
  const child = spawn(options.command, [...(options.args ?? [])], {
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    ...(options.env ? { env: options.env } : {}),
  });
  let stderr = "";
  let terminalError: Error | undefined;
  child.on("error", (error) => {
    terminalError = error;
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_096);
  });
  const listeners = new Set<(notification: SessionNotification) => void>();
  let permissionHandler: ((request: RequestPermissionRequest) => Promise<RequestPermissionResponse>) | undefined;
  const app = client({ name: "pho-code" })
    .onRequest(methods.client.session.requestPermission, ({ params }) =>
      permissionHandler?.(params) ?? { outcome: { outcome: "cancelled" } })
    .onNotification(methods.client.session.update, ({ params }) => {
      for (const listener of listeners) listener(params);
    });
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  const connection = app.connect(stream);
  return new SdkAcpClient(connection, listeners, (handler) => {
    permissionHandler = handler;
    return () => {
      if (permissionHandler === handler) permissionHandler = undefined;
    };
  }, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }, () => terminalError, () => stderr.trim());
}

class SdkAcpClient implements AcpClient {
  readonly #context: ClientContext;
  readonly #connection: ClientConnection;
  readonly #listeners: Set<(notification: SessionNotification) => void>;
  readonly #setPermissionHandler: (
    handler: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>,
  ) => Unsubscribe;
  readonly #kill: () => void;
  readonly #terminalError: () => Error | undefined;
  readonly #stderr: () => string;
  #initialize?: InitializeResponse;
  #disposed = false;

  constructor(
    connection: ClientConnection,
    listeners: Set<(notification: SessionNotification) => void>,
    setPermissionHandler: (
      handler: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>,
    ) => Unsubscribe,
    kill: () => void,
    terminalError: () => Error | undefined,
    stderr: () => string,
  ) {
    this.#connection = connection;
    this.#context = connection.agent;
    this.#listeners = listeners;
    this.#setPermissionHandler = setPermissionHandler;
    this.#kill = kill;
    this.#terminalError = terminalError;
    this.#stderr = stderr;
  }

  async initialize(): Promise<InitializeResponse> {
    this.#requireAvailable();
    if (this.#initialize) return this.#initialize;
    try {
      this.#initialize = await this.#context.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "pho-code", title: "Pho Code", version: "0.0.0" },
      });
      if (this.#initialize.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(`Unsupported ACP protocol version: ${this.#initialize.protocolVersion}.`);
      }
      return this.#initialize;
    } catch (error) {
      // The SDK stream can report closure just before ChildProcess emits ENOENT.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const terminalError = this.#terminalError();
      if (terminalError) {
        throw new Error(`ACP agent failed to start: ${terminalError.message}`, { cause: terminalError });
      }
      const detail = this.#stderr();
      if (!detail) throw error;
      throw new Error(`${error instanceof Error ? error.message : String(error)} ${detail}`, { cause: error });
    }
  }

  async createSession(cwd: string): Promise<string> {
    this.#requireInitialized();
    const response = await this.#context.request(methods.agent.session.new, { cwd, mcpServers: [] });
    return response.sessionId;
  }

  async openSession(sessionId: string, cwd: string): Promise<void> {
    const capabilities = this.#requireInitialized().agentCapabilities;
    if (capabilities?.loadSession) {
      await this.#context.request(methods.agent.session.load, { sessionId, cwd, mcpServers: [] });
      return;
    }
    if (capabilities?.sessionCapabilities?.resume) {
      await this.#context.request(methods.agent.session.resume, { sessionId, cwd, mcpServers: [] });
      return;
    }
    throw new Error("The ACP agent cannot load or resume sessions.");
  }

  prompt(sessionId: string, text: string): Promise<PromptResponse> {
    this.#requireInitialized();
    return this.#context.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text }],
    });
  }

  async cancel(sessionId: string): Promise<void> {
    this.#requireInitialized();
    await this.#context.notify(methods.agent.session.cancel, { sessionId });
  }

  setPermissionHandler(
    handler: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>,
  ): Unsubscribe {
    this.#requireAvailable();
    return this.#setPermissionHandler(handler);
  }

  subscribe(listener: (notification: SessionNotification) => void): Unsubscribe {
    this.#requireAvailable();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#listeners.clear();
    this.#connection.close();
    this.#kill();
    await this.#connection.closed.catch(() => undefined);
  }

  #requireAvailable(): void {
    if (this.#disposed) throw new Error("The ACP client is disposed.");
  }

  #requireInitialized(): InitializeResponse {
    this.#requireAvailable();
    if (!this.#initialize) throw new Error("The ACP client is not initialized.");
    return this.#initialize;
  }
}
