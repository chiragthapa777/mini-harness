import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import {
  ErrorCode,
  PROTOCOL_VERSION,
  RpcError,
  type CommandParams,
  type CoreEndpoint,
  type InitializeParams,
  type InitializeResult,
  type PermissionMode,
} from "@mini-agent/coder-protocol";
import type { ChatClient, Msg } from "@mini-agent/llm";
import { Checkpoints } from "./checkpoints.js";
import { alwaysKey, modeGate, type PermissionGate } from "./gate.js";
import { DEFAULT_LIMITS, runLoop, type Authorization, type Limits } from "./loop.js";
import { DEFAULT_MODEL, formatModel, parseModel, type ModelSpec } from "./model.js";
import { buildSystemPrompt } from "./prompt.js";
import type { Tool } from "./tool.js";

export interface SessionDeps {
  tools: Tool[];
  /** Builds the chat client for a model; `serve.ts` passes `chatModel` from `packages/llm`. */
  createModel(spec: ModelSpec): ChatClient;
  /** `provider:model`, used when `initialize` names none. */
  defaultModel?: string;
  limits?: Partial<Limits>;
  /** Called once `shutdown` has been answered, or the UI has gone away. */
  onShutdown?(): void;
  /** Injected for tests. */
  now?(): Date;
}

interface Ready {
  sessionId: string;
  root: string;
  spec: ModelSpec;
  model: ChatClient;
  mode: PermissionMode;
  gate: PermissionGate;
  system: string;
}

interface Turn {
  controller: AbortController;
  done: Promise<void>;
}

/**
 * The controller: answers the UI's requests, runs one turn at a time, and is
 * the only thing that talks to the endpoint. Everything it knows about the
 * conversation lives here, for this process's lifetime — persistence is the
 * memory layer's job (phase 7).
 */
export class Session {
  readonly #endpoint: CoreEndpoint;
  readonly #deps: SessionDeps;
  readonly #limits: Limits;
  readonly #history: Msg[] = [];
  readonly #checkpoints = new Checkpoints();
  readonly #reads = new Map<string, number>();
  readonly #always = new Set<string>();
  /** Notes for the model about things done outside the conversation (an undo). */
  readonly #notes: string[] = [];
  readonly #shell = { cwd: "" };
  #ready?: Ready;
  #turn?: Turn;
  #callCount = 0;
  #stopped = false;
  #finished = false;

  constructor(endpoint: CoreEndpoint, deps: SessionDeps) {
    this.#endpoint = endpoint;
    this.#deps = deps;
    this.#limits = { ...DEFAULT_LIMITS, ...deps.limits };

    endpoint.handle({
      initialize: (params) => this.#initialize(params),
      submit: ({ text }) => this.#submit(text),
      abort: () => {
        this.#turn?.controller.abort(new Error("aborted by the user"));
        return {};
      },
      command: (params) => this.#command(params),
      shutdown: async () => {
        await this.#stop();
        // After the reply is on its way, not before it.
        setImmediate(() => this.#finish());
        return {};
      },
    });

    // The UI went away (closed our stdin, crashed): same as shutdown.
    endpoint.onClose(() => {
      void this.#stop().then(() => this.#finish());
    });
  }

  /** Resolves when the running turn, if any, has finished. For tests and shutdown. */
  async idle(): Promise<void> {
    await this.#turn?.done;
  }

  /** Aborts the running turn (killing any command it started) and refuses new ones. */
  stop(): Promise<void> {
    return this.#stop();
  }

  async #initialize(params: InitializeParams): Promise<InitializeResult> {
    if (this.#ready) throw new RpcError(ErrorCode.Rejected, "already initialized");
    if (params.resume) throw new RpcError(ErrorCode.Rejected, "resuming a session is not supported yet");

    let root: string;
    try {
      root = await realpath(params.cwd);
      if (!(await stat(root)).isDirectory()) throw new Error("not a directory");
    } catch (err) {
      throw new RpcError(ErrorCode.Rejected, `cannot use ${params.cwd} as the project root: ${(err as Error).message}`);
    }

    const spec = this.#parseModel(params.model ?? this.#deps.defaultModel ?? DEFAULT_MODEL);
    const mode = params.mode ?? "default";
    const now = this.#deps.now?.() ?? new Date();

    this.#shell.cwd = root;
    this.#ready = {
      sessionId: randomUUID(),
      root,
      spec,
      model: this.#deps.createModel(spec),
      mode,
      gate: modeGate(mode),
      system: buildSystemPrompt(this.#deps.tools, {
        root,
        platform: process.platform,
        date: now.toISOString().slice(0, 10),
      }),
    };

    return {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.#ready.sessionId,
      model: formatModel(spec),
      mode,
    };
  }

  #submit(text: string): Record<string, never> {
    const ready = this.#requireReady();
    if (this.#turn) throw new RpcError(ErrorCode.Rejected, "a turn is already running");
    if (this.#stopped) throw new RpcError(ErrorCode.Rejected, "the session is shutting down");

    const controller = new AbortController();
    const turn: Turn = { controller, done: Promise.resolve() };
    this.#turn = turn;
    turn.done = this.#runTurn(ready, text, controller.signal).finally(() => {
      if (this.#turn === turn) this.#turn = undefined;
    });
    return {};
  }

  async #runTurn(ready: Ready, text: string, signal: AbortSignal): Promise<void> {
    const notes = this.#notes.splice(0);
    const content = notes.length ? `${notes.map((n) => `[note: ${n}]`).join("\n")}\n\n${text}` : text;

    this.#checkpoints.begin();
    this.#history.push({ role: "user", content });
    this.#endpoint.event({ type: "turn_start" });

    let stopReason: Awaited<ReturnType<typeof runLoop>>["stopReason"] = "error";
    let error: string | undefined;
    try {
      ({ stopReason } = await runLoop(this.#history, {
        model: ready.model,
        tools: this.#deps.tools,
        system: ready.system,
        limits: this.#limits,
        signal,
        emit: (event) => this.#endpoint.event(event),
        authorize: (tool, input, callId) => this.#authorize(ready, tool, input, callId, signal),
        nextCallId: () => `call_${++this.#callCount}`,
        context: {
          root: ready.root,
          reads: this.#reads,
          shell: this.#shell,
          checkpoint: (path) => this.#checkpoints.save(path),
        },
      }));
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    // Free the session before announcing the end, so a UI that submits the
    // moment it sees turn_end is not told a turn is still running.
    this.#turn = undefined;
    this.#endpoint.event({ type: "turn_end", stopReason, ...(error ? { error } : {}) });
  }

  async #authorize(
    ready: Ready,
    tool: Tool,
    input: unknown,
    callId: string,
    signal: AbortSignal,
  ): Promise<Authorization> {
    const key = alwaysKey(tool, input);
    if (this.#always.has(key)) return { allowed: true };

    const verdict = ready.gate.check(tool, input);
    if (verdict.decision === "allow") return { allowed: true };
    if (verdict.decision === "deny") return { allowed: false, reason: verdict.reason };

    try {
      const { decision } = await this.#endpoint.askPermission(
        { callId, tool: tool.name, input, reason: verdict.reason },
        signal,
      );
      if (decision === "deny") return { allowed: false, reason: "the user denied this call" };
      if (decision === "always") this.#always.add(key);
      return { allowed: true };
    } catch (err) {
      // Aborted while waiting, or the UI is gone: a question nobody answered is a no.
      return {
        allowed: false,
        reason: signal.aborted ? "the user aborted the turn" : `no answer: ${(err as Error).message}`,
      };
    }
  }

  async #command({ name, arg }: CommandParams): Promise<{ message: string }> {
    const ready = this.#requireReady();
    if (this.#turn) throw new RpcError(ErrorCode.Rejected, `/${name} cannot run during a turn`);

    switch (name) {
      case "clear":
        this.#history.length = 0;
        this.#reads.clear();
        this.#notes.length = 0;
        return { message: "conversation cleared" };

      case "undo": {
        const paths = await this.#checkpoints.undo();
        if (!paths.length) return { message: "nothing to undo" };
        // The files changed under the model: make it re-read before editing.
        for (const path of paths) this.#reads.delete(path);
        const list = paths.map((path) => this.#relative(ready, path)).join(", ");
        this.#notes.push(`the user undid your last file changes: ${list}. Re-read before editing them.`);
        return {
          message: `restored ${paths.length} file${paths.length === 1 ? "" : "s"}: ${list}. Changes made through bash are not undone.`,
        };
      }

      case "model": {
        if (!arg) return { message: `model: ${formatModel(ready.spec)}` };
        const spec = this.#parseModel(arg);
        ready.spec = spec;
        ready.model = this.#deps.createModel(spec);
        return { message: `model set to ${formatModel(spec)}` };
      }

      case "compact":
        return { message: "compaction is not available yet" };
    }
  }

  async #stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#turn?.controller.abort(new Error("shutting down"));
    await this.idle();
  }

  /** `shutdown` followed by the pipe closing must not exit twice. */
  #finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#deps.onShutdown?.();
  }

  #requireReady(): Ready {
    if (!this.#ready) throw new RpcError(ErrorCode.Rejected, "initialize first");
    return this.#ready;
  }

  #parseModel(spec: string): ModelSpec {
    try {
      return parseModel(spec);
    } catch (err) {
      throw new RpcError(ErrorCode.InvalidParams, (err as Error).message);
    }
  }

  #relative(ready: Ready, path: string): string {
    return path.startsWith(`${ready.root}/`) ? path.slice(ready.root.length + 1) : path;
  }
}
