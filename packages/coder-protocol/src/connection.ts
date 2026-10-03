import type { Readable, Writable } from "node:stream";

/**
 * JSON-RPC 2.0 over newline-delimited JSON, symmetric: either side may send
 * requests, answer them, and send notifications. The core uses it over its
 * stdin/stdout; the UI over the child's pipes; tests over in-memory streams.
 *
 * This layer is untyped on purpose — it moves `unknown` around and knows
 * nothing about mini-coder's methods. `endpoints.ts` puts the typed,
 * validated API on top.
 */

export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** Application errors: a turn already running, a version mismatch, … */
  Rejected: -32000,
} as const;

/** An error with a JSON-RPC code. Thrown by handlers, and by `request` when the peer answers with one. */
export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

export class ConnectionClosedError extends Error {
  constructor() {
    super("connection closed");
    this.name = "ConnectionClosedError";
  }
}

type RequestHandler = (params: unknown) => unknown;
type NotificationHandler = (params: unknown) => void;

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  cleanup(): void;
}

interface Message {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown; data?: unknown };
}

export class Connection {
  readonly #output: Writable;
  readonly #requests = new Map<string, RequestHandler>();
  readonly #notifications = new Map<string, NotificationHandler>();
  readonly #pending = new Map<number, Pending>();
  readonly #closeListeners: (() => void)[] = [];
  #buffer = "";
  #nextId = 1;
  #closed = false;

  constructor(input: Readable, output: Writable) {
    this.#output = output;
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => this.#onData(chunk));
    input.on("end", () => this.close());
    input.on("close", () => this.close());
    input.on("error", () => this.close());
    // A peer that has gone away must not crash this process with EPIPE.
    output.on("error", () => this.close());
  }

  get closed(): boolean {
    return this.#closed;
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.#requests.set(method, handler);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.#notifications.set(method, handler);
  }

  onClose(listener: () => void): void {
    if (this.#closed) listener();
    else this.#closeListeners.push(listener);
  }

  /**
   * Sends a request and resolves with the peer's result. Aborting `signal`
   * rejects at once with the signal's reason and forgets the request, so a
   * late answer is dropped rather than delivered to nobody.
   */
  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.#closed) return Promise.reject(new ConnectionClosedError());
    if (signal?.aborted) return Promise.reject(signal.reason);

    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.#pending.delete(id);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      this.#pending.set(id, {
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.#closed) return;
    this.#send({ jsonrpc: "2.0", method, params });
  }

  /** Idempotent. Rejects everything still waiting for an answer. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [id, pending] of this.#pending) {
      pending.cleanup();
      pending.reject(new ConnectionClosedError());
      this.#pending.delete(id);
    }
    for (const listener of this.#closeListeners.splice(0)) listener();
  }

  #send(message: object): void {
    if (this.#output.writableEnded || this.#output.destroyed) return;
    this.#output.write(`${JSON.stringify(message)}\n`);
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    // A message is complete only at its newline; whatever follows the last
    // one is a partial that waits for the next chunk.
    const lines = this.#buffer.split("\n");
    this.#buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      let message: Message;
      try {
        message = JSON.parse(line) as Message;
      } catch {
        this.#send({
          jsonrpc: "2.0",
          id: null,
          error: { code: ErrorCode.ParseError, message: "invalid JSON" },
        });
        continue;
      }
      this.#dispatch(message);
    }
  }

  #dispatch(message: Message): void {
    if (typeof message !== "object" || message === null) {
      this.#send({
        jsonrpc: "2.0",
        id: null,
        error: { code: ErrorCode.InvalidRequest, message: "not a JSON-RPC message" },
      });
      return;
    }

    if (typeof message.method === "string") {
      if (message.id === undefined || message.id === null) this.#onNotification(message);
      else void this.#onRequest(message);
      return;
    }

    if (typeof message.id === "number") this.#onResponse(message);
  }

  #onNotification(message: Message): void {
    // Notifications get no reply, not even for an unknown method.
    this.#notifications.get(message.method as string)?.(message.params);
  }

  async #onRequest(message: Message): Promise<void> {
    const id = message.id;
    const handler = this.#requests.get(message.method as string);
    if (!handler) {
      this.#send({
        jsonrpc: "2.0",
        id,
        error: { code: ErrorCode.MethodNotFound, message: `unknown method: ${String(message.method)}` },
      });
      return;
    }

    try {
      const result = await handler(message.params ?? {});
      this.#send({ jsonrpc: "2.0", id, result: result ?? {} });
    } catch (err) {
      const error =
        err instanceof RpcError
          ? { code: err.code, message: err.message, ...(err.data === undefined ? {} : { data: err.data }) }
          : { code: ErrorCode.InternalError, message: err instanceof Error ? err.message : String(err) };
      this.#send({ jsonrpc: "2.0", id, error });
    }
  }

  #onResponse(message: Message): void {
    const id = message.id as number;
    const pending = this.#pending.get(id);
    if (!pending) return; // answered after its request was abandoned
    this.#pending.delete(id);
    pending.cleanup();

    if (message.error) {
      const { code, message: text, data } = message.error;
      pending.reject(
        new RpcError(
          typeof code === "number" ? code : ErrorCode.InternalError,
          typeof text === "string" ? text : "request failed",
          data,
        ),
      );
    } else {
      pending.resolve(message.result);
    }
  }
}
