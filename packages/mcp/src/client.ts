import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * A minimal MCP client over the stdio transport.
 *
 * MCP's stdio transport is JSON-RPC 2.0 in newline-delimited JSON over a child
 * process's stdin/stdout — three methods' worth of protocol for what we need
 * (`initialize`, `tools/list`, `tools/call`). That is small enough to own,
 * and owning it keeps the surface honest: this package can never quietly grow
 * into a second agent framework the way a vendored SDK might.
 *
 * Everything here is transport. Turning MCP tools into `AgentTool`s — the
 * harness's own shape, called through the same `tool_call` fence as every
 * other tool — happens in `tools.ts`.
 */

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Per-request ceiling. A hung server must not hang the run. */
  timeoutMs?: number;
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TIMEOUT_MS = 30_000;

export class McpClient {
  readonly name: string;
  readonly #config: McpServerConfig;
  #child?: ChildProcessWithoutNullStreams;
  #buffer = "";
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #ready?: Promise<void>;
  #closed = false;

  constructor(name: string, config: McpServerConfig) {
    this.name = name;
    this.#config = config;
  }

  /** Idempotent: several tools on one server share a single handshake. */
  async connect(): Promise<void> {
    this.#ready ??= this.#handshake();
    return this.#ready;
  }

  async listTools(): Promise<McpToolDefinition[]> {
    await this.connect();
    const result = (await this.#request("tools/list", {})) as { tools?: McpToolDefinition[] };
    return result.tools ?? [];
  }

  /**
   * Call a tool and flatten its content blocks to text — the harness feeds
   * tool results back as a plain user turn, so text is the only shape that
   * survives the trip. An `isError` result is thrown, which is what puts it in
   * front of the model as a tool error rather than as an answer.
   */
  async callTool(name: string, args: unknown): Promise<string> {
    await this.connect();
    const result = (await this.#request("tools/call", { name, arguments: args ?? {} })) as {
      content?: { type?: string; text?: string }[];
      isError?: boolean;
    };

    const text = (result.content ?? [])
      .map((block) =>
        block.type === "text" ? (block.text ?? "") : `[${block.type ?? "unknown"} content]`,
      )
      .filter(Boolean)
      .join("\n")
      .trim();

    if (result.isError) throw new Error(text || `${name} failed`);
    return text || "(no output)";
  }

  close(): void {
    this.#closed = true;
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`mcp server "${this.name}" closed`));
      this.#pending.delete(id);
    }
    this.#child?.kill();
    this.#child = undefined;
    this.#ready = undefined;
  }

  async #handshake(): Promise<void> {
    const child = spawn(this.#config.command, this.#config.args ?? [], {
      // The server inherits our environment plus its own additions: most MCP
      // servers need PATH, and several need a credential from the parent.
      env: { ...process.env, ...this.#config.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;

    child.stdout.on("data", (chunk: Buffer) => this.#onData(chunk.toString()));
    // A server's stderr is its log, not our protocol stream — surface it
    // tagged rather than letting it disappear.
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.warn(`[mcp:${this.name}] ${text}`);
    });
    child.on("error", (err) => this.#fail(new Error(`mcp server "${this.name}": ${err.message}`)));
    child.on("exit", (code) => {
      if (!this.#closed) this.#fail(new Error(`mcp server "${this.name}" exited (code ${code})`));
    });

    await this.#request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "mini-agent", version: "0.0.0" },
    });
    // Notification, not a request: no id, and no reply is coming.
    this.#send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    // Newline-delimited JSON: a message is only complete at the newline, and
    // anything after the last one is a partial that has to wait.
    const lines = this.#buffer.split("\n");
    this.#buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let message: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(trimmed);
      } catch {
        // Servers that print to stdout instead of stderr would otherwise take
        // down the connection over a log line.
        console.warn(`[mcp:${this.name}] ignoring non-JSON output: ${trimmed.slice(0, 120)}`);
        continue;
      }

      if (typeof message.id !== "number") continue; // a notification from the server
      const pending = this.#pending.get(message.id);
      if (!pending) continue;

      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "mcp error"));
      else pending.resolve(message.result);
    }
  }

  #request(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextId++;
    const timeoutMs = this.#config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`mcp server "${this.name}" timed out on ${method}`));
      }, timeoutMs);
      // Keeping a pending timer alive would hold the process open after a run.
      timer.unref?.();

      this.#pending.set(id, { resolve, reject, timer });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  #send(message: unknown): void {
    this.#child?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** A dead process fails every request waiting on it, rather than hanging. */
  #fail(error: Error): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.#pending.delete(id);
    }
    this.#ready = undefined;
    this.#child = undefined;
  }
}
