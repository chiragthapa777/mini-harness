import type { Readable, Writable } from "node:stream";

/**
 * JSON-RPC 2.0, one JSON object per line. Both sides can send requests,
 * answer them, and send notifications.
 */

/** An error the other side receives with its code and message. */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly code = -32000,
  ) {
    super(message);
  }
}

type Handler = (params: unknown) => unknown;

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

export class Connection {
  private handlers = new Map<string, Handler>();
  private pending = new Map<number, Pending>();
  private closeListeners: (() => void)[] = [];
  private buffer = "";
  private nextId = 1;
  closed = false;

  constructor(
    input: Readable,
    private output: Writable,
  ) {
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => this.read(chunk));
    input.on("close", () => this.close());
    input.on("end", () => this.close());
    output.on("error", () => this.close()); // the other side went away
  }

  /** Handles both requests and notifications for `method`. */
  on(method: string, handler: Handler): void {
    this.handlers.set(method, handler);
  }

  onClose(listener: () => void): void {
    if (this.closed) listener();
    else this.closeListeners.push(listener);
  }

  /** Sends a request. Aborting `signal` stops waiting; a late answer is ignored. */
  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("connection closed"));
    signal?.throwIfAborted();

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      signal?.addEventListener("abort", () => {
        this.pending.delete(id);
        reject(signal.reason);
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.closed) this.send({ jsonrpc: "2.0", method, params });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const { reject } of this.pending.values()) reject(new Error("connection closed"));
    this.pending.clear();
    for (const listener of this.closeListeners) listener();
  }

  private send(message: object): void {
    if (!this.output.writableEnded) this.output.write(JSON.stringify(message) + "\n");
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? ""; // an unfinished line waits for the next chunk

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        void this.receive(JSON.parse(line));
      } catch {
        // not JSON: ignore the line
      }
    }
  }

  private async receive(message: any): Promise<void> {
    // A response to one of our requests.
    if (message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new RpcError(message.error.message, message.error.code));
      else pending.resolve(message.result);
      return;
    }

    const handler = this.handlers.get(message.method);

    // A notification: no reply.
    if (message.id === undefined) {
      handler?.(message.params);
      return;
    }

    // A request: always reply, with a result or an error.
    const { id } = message;
    if (!handler) {
      this.send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method: ${message.method}` } });
      return;
    }
    try {
      const result = await handler(message.params ?? {});
      this.send({ jsonrpc: "2.0", id, result: result ?? {} });
    } catch (err) {
      const code = err instanceof RpcError ? err.code : -32603;
      const text = err instanceof Error ? err.message : String(err);
      this.send({ jsonrpc: "2.0", id, error: { code, message: text } });
    }
  }
}
