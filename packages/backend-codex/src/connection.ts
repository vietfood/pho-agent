import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { Unsubscribe } from "@pho-agent/protocol";

export interface CodexNotification {
  method: string;
  params?: unknown;
}

export interface CodexServerRequest extends CodexNotification {
  id: number | string;
}

export type CodexServerRequestHandler = (request: CodexServerRequest) => Promise<unknown>;

export interface CodexAppServerConnection {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  subscribe(listener: (notification: CodexNotification) => void): Unsubscribe;
  setRequestHandler(handler: CodexServerRequestHandler): Unsubscribe;
  dispose(): Promise<void>;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(reason: Error): void;
}

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export function createCodexStdioConnection(command = "codex"): CodexAppServerConnection {
  return new StdioConnection(spawn(command, ["app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  }));
}

class StdioConnection implements CodexAppServerConnection {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #listeners = new Set<(notification: CodexNotification) => void>();
  #nextId = 1;
  #requestHandler: CodexServerRequestHandler | undefined;
  #disposed = false;
  #terminalError: Error | undefined;
  #stderr = "";

  constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.#receive(line));
    child.stderr.on("data", (chunk: Buffer) => {
      this.#stderr = `${this.#stderr}${chunk.toString("utf8")}`.slice(-4_096);
    });
    child.on("error", (error) => this.#terminate(error));
    child.on("exit", (code, signal) => {
      if (this.#disposed) return;
      const detail = this.#stderr.trim();
      this.#terminate(new Error(
        `Codex app-server exited (${signal ?? code ?? "unknown"}).${detail ? ` ${detail}` : ""}`,
      ));
    });
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.#disposed) return Promise.reject(new Error("The Codex app-server connection is disposed."));
    if (this.#terminalError) return Promise.reject(this.#terminalError);
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.#disposed) throw new Error("The Codex app-server connection is disposed.");
    if (this.#terminalError) throw this.#terminalError;
    this.#write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  subscribe(listener: (notification: CodexNotification) => void): Unsubscribe {
    if (this.#disposed) throw new Error("The Codex app-server connection is disposed.");
    if (this.#terminalError) throw this.#terminalError;
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  setRequestHandler(handler: CodexServerRequestHandler): Unsubscribe {
    if (this.#disposed) throw new Error("The Codex app-server connection is disposed.");
    if (this.#terminalError) throw this.#terminalError;
    if (this.#requestHandler) throw new Error("The Codex app-server request handler is already set.");
    this.#requestHandler = handler;
    return () => {
      if (this.#requestHandler === handler) this.#requestHandler = undefined;
    };
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#listeners.clear();
    this.#requestHandler = undefined;
    this.#failAll(new Error("The Codex app-server connection was disposed."));
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      this.#child.once("exit", () => resolve());
      this.#child.kill();
    });
  }

  #receive(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.#terminate(new Error("Codex app-server emitted malformed JSON."));
      return;
    }
    if (message.id !== undefined && message.method) {
      void this.#handleServerRequest({ id: message.id, method: message.method, params: message.params });
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? `Codex request failed (${message.error.code ?? "unknown"}).`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method) {
      for (const listener of this.#listeners) listener({ method: message.method, params: message.params });
    }
  }

  async #handleServerRequest(request: CodexServerRequest): Promise<void> {
    if (!this.#requestHandler) {
      this.#write({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: `Unsupported server request: ${request.method}` },
      });
      return;
    }
    try {
      const result = await this.#requestHandler(request);
      this.#write({ jsonrpc: "2.0", id: request.id, result });
    } catch {
      this.#write({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32000, message: "The client could not resolve this server request." },
      });
    }
  }

  #write(message: unknown): void {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  #terminate(error: Error): void {
    this.#terminalError ??= error;
    this.#failAll(this.#terminalError);
  }
}
