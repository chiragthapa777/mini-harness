import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import {
  PROTOCOL_VERSION,
  RpcError,
  type CommandParams,
  type CommandResult,
  type CoreEndpoint,
  type InitializeParams,
  type InitializeResult,
  type PermissionMode,
  type StopReason,
} from "@mini-agent/coder-protocol";
import type { ChatClient, Msg } from "@mini-agent/llm";
import { Checkpoints } from "./checkpoints.js";
import { alwaysKey, checkPermission } from "./gate.js";
import { DEFAULT_LIMITS, runLoop, type Limits } from "./loop.js";
import { DEFAULT_MODEL, formatModel, parseModel, type ModelSpec } from "./model.js";
import { buildSystemPrompt } from "./prompt.js";
import type { Tool } from "./tool.js";

export interface SessionOptions {
  tools: Tool[];
  createModel(spec: ModelSpec): ChatClient;
  defaultModel?: string; // "provider:model"
  limits?: Partial<Limits>;
  /** Called once, after shutdown or when the UI goes away. */
  onShutdown?(): void;
}

/** Set by `initialize`. */
interface Setup {
  root: string;
  spec: ModelSpec;
  model: ChatClient;
  mode: PermissionMode;
  system: string;
}

/**
 * The controller. Answers the UI's requests and runs one turn at a time.
 * Everything here lives in memory for this process only.
 */
export class Session {
  private setup?: Setup;
  private turn?: { controller: AbortController; done: Promise<void> };
  private history: Msg[] = [];
  private checkpoints = new Checkpoints();
  private reads = new Map<string, number>(); // file → mtime when read
  private shell = { cwd: "" };
  private alwaysAllowed = new Set<string>();
  private callCount = 0;
  private shuttingDown = false;
  private limits: Limits;

  constructor(
    private endpoint: CoreEndpoint,
    private options: SessionOptions,
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };

    endpoint.handle({
      initialize: (params) => this.initialize(params),
      submit: ({ text }) => this.submit(text),
      abort: () => this.turn?.controller.abort(new Error("aborted by the user")),
      command: (params) => this.command(params),
      shutdown: () => this.shutdown(),
    });
    endpoint.onClose(() => void this.shutdown()); // the UI went away
  }

  /** Resolves when the running turn, if any, is over. */
  async idle(): Promise<void> {
    await this.turn?.done;
  }

  /** Aborts the running turn and waits for it to end. */
  async stop(): Promise<void> {
    this.turn?.controller.abort(new Error("shutting down"));
    await this.idle();
  }

  private async initialize(params: InitializeParams): Promise<InitializeResult> {
    if (this.setup) throw new RpcError("already initialized");
    if (params.resume) throw new RpcError("resuming a session is not supported yet");

    const root = await realpath(params.cwd).catch(() => "");
    if (!root || !(await stat(root)).isDirectory()) throw new RpcError(`not a directory: ${params.cwd}`);

    const spec = this.parseModel(params.model ?? this.options.defaultModel ?? DEFAULT_MODEL);
    const mode = params.mode ?? "default";
    const system = buildSystemPrompt(this.options.tools, {
      root,
      platform: process.platform,
      date: new Date().toISOString().slice(0, 10),
    });

    this.setup = { root, spec, model: this.options.createModel(spec), mode, system };
    this.shell.cwd = root;
    return { protocolVersion: PROTOCOL_VERSION, sessionId: randomUUID(), model: formatModel(spec), mode };
  }

  private submit(text: string): void {
    if (!this.setup) throw new RpcError("initialize first");
    if (this.turn) throw new RpcError("a turn is already running");
    if (this.shuttingDown) throw new RpcError("shutting down");

    const controller = new AbortController();
    this.turn = { controller, done: this.runTurn(this.setup, text, controller.signal) };
  }

  private async runTurn(setup: Setup, text: string, signal: AbortSignal): Promise<void> {
    this.checkpoints.begin();
    this.history.push({ role: "user", content: text });
    this.endpoint.event({ type: "turn_start" });

    let stopReason: StopReason;
    let error: string | undefined;
    try {
      stopReason = await runLoop(this.history, {
        model: setup.model,
        tools: this.options.tools,
        system: setup.system,
        limits: this.limits,
        signal,
        emit: (event) => this.endpoint.event(event),
        authorize: (tool, input, callId) => this.authorize(setup, tool, input, callId, signal),
        nextCallId: () => `call_${++this.callCount}`,
        context: {
          root: setup.root,
          reads: this.reads,
          shell: this.shell,
          checkpoint: (path) => this.checkpoints.save(path),
        },
      });
    } catch (err) {
      stopReason = "error";
      error = (err as Error).message;
    }

    // Free the session first, so the UI can submit as soon as it sees turn_end.
    this.turn = undefined;
    this.endpoint.event({ type: "turn_end", stopReason, error });
  }

  /** Returns why the call may not run, or null when it may. */
  private async authorize(
    setup: Setup,
    tool: Tool,
    input: unknown,
    callId: string,
    signal: AbortSignal,
  ): Promise<string | null> {
    if (this.alwaysAllowed.has(alwaysKey(tool, input))) return null;

    const verdict = checkPermission(setup.mode, tool);
    if (verdict.decision === "allow") return null;
    if (verdict.decision === "deny") return verdict.reason;

    try {
      const { decision } = await this.endpoint.askPermission(
        { callId, tool: tool.name, input, reason: verdict.reason },
        signal,
      );
      if (decision === "deny") return "the user denied this call";
      if (decision === "always") this.alwaysAllowed.add(alwaysKey(tool, input));
      return null;
    } catch (err) {
      return signal.aborted ? "the user aborted the turn" : `no answer: ${(err as Error).message}`;
    }
  }

  private async command({ name, arg }: CommandParams): Promise<CommandResult> {
    if (!this.setup) throw new RpcError("initialize first");
    if (this.turn) throw new RpcError(`/${name} cannot run during a turn`);

    if (name === "clear") {
      this.history = [];
      this.reads.clear();
      return { message: "conversation cleared" };
    }

    if (name === "undo") {
      const paths = await this.checkpoints.undo();
      if (paths.length === 0) return { message: "nothing to undo" };
      // The files changed: make the model read them again before editing.
      for (const path of paths) this.reads.delete(path);
      const list = paths.map((p) => p.replace(this.setup!.root + "/", "")).join(", ");
      return { message: `restored ${list}. Changes made through bash are not undone.` };
    }

    if (name === "model") {
      if (!arg) return { message: `model: ${formatModel(this.setup.spec)}` };
      this.setup.spec = this.parseModel(arg);
      this.setup.model = this.options.createModel(this.setup.spec);
      return { message: `model set to ${arg}` };
    }

    return { message: "compaction is not available yet" };
  }

  private async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    await this.stop();
    // Exit on the next tick, so the reply to `shutdown` is sent first.
    setImmediate(() => this.options.onShutdown?.());
  }

  private parseModel(spec: string): ModelSpec {
    try {
      return parseModel(spec);
    } catch (err) {
      throw new RpcError((err as Error).message, -32602);
    }
  }
}
