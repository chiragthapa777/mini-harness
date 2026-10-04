import { realpathSync, statSync } from "node:fs";
import type { ChatClient, Msg } from "@mini-agent/llm";
import { Checkpoints } from "./checkpoints.js";
import { alwaysKey, checkPermission } from "./gate.js";
import { DEFAULT_LIMITS, runLoop, type Limits } from "./loop.js";
import { DEFAULT_MODEL, formatModel, parseModel, type ModelSpec } from "./model.js";
import { buildSystemPrompt } from "./prompt.js";
import type { Tool } from "./tool.js";
import type { Command, CoreMessage, Decision, PermissionMode, StopReason, UiMessage } from "./wire.js";

export interface SessionOptions {
  cwd: string;
  tools: Tool[];
  createModel(spec: ModelSpec): ChatClient;
  model?: string; // "provider:model"
  mode?: PermissionMode;
  limits?: Partial<Limits>;
}

/**
 * The controller: takes the UI's messages in `receive`, answers through
 * `send`, and runs one turn at a time. Everything here lives in memory for
 * this process only.
 */
export class Session {
  private root: string;
  private spec: ModelSpec;
  private model: ChatClient;
  private mode: PermissionMode;
  private system: string;
  private turn?: { controller: AbortController; done: Promise<void> };
  private history: Msg[] = [];
  private checkpoints = new Checkpoints();
  private reads = new Map<string, number>(); // file → mtime when read
  private shell: { cwd: string };
  private alwaysAllowed = new Set<string>();
  private waitingPermissions = new Map<string, (decision: Decision) => void>(); // by callId
  private callCount = 0;
  private limits: Limits;

  /** Throws when the folder or the model is not usable. */
  constructor(
    private send: (message: CoreMessage) => void,
    private options: SessionOptions,
  ) {
    if (!statSync(options.cwd, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`not a directory: ${options.cwd}`);
    }
    this.root = realpathSync(options.cwd);
    this.shell = { cwd: this.root };
    this.spec = parseModel(options.model ?? DEFAULT_MODEL);
    this.model = options.createModel(this.spec);
    this.mode = options.mode ?? "default";
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.system = buildSystemPrompt(options.tools, {
      root: this.root,
      platform: process.platform,
      date: new Date().toISOString().slice(0, 10),
    });
    this.sendSession();
  }

  receive(message: UiMessage): void {
    if (message.type === "submit") this.submit(message.text);
    if (message.type === "abort") this.turn?.controller.abort(new Error("aborted by the user"));
    if (message.type === "command") void this.command(message.name, message.arg);
    if (message.type === "permission_answer") this.waitingPermissions.get(message.callId)?.(message.decision);
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

  private submit(text: string): void {
    if (this.turn) return this.send({ type: "notice", text: "a turn is already running", isError: true });

    const controller = new AbortController();
    this.turn = { controller, done: this.runTurn(text, controller.signal) };
  }

  private async runTurn(text: string, signal: AbortSignal): Promise<void> {
    this.checkpoints.begin();
    this.history.push({ role: "user", content: text });
    this.send({ type: "turn_start" });

    let stopReason: StopReason;
    let error: string | undefined;
    try {
      stopReason = await runLoop(this.history, {
        model: this.model,
        tools: this.options.tools,
        system: this.system,
        limits: this.limits,
        signal,
        emit: this.send,
        authorize: (tool, input, callId) => this.authorize(tool, input, callId, signal),
        nextCallId: () => `call_${++this.callCount}`,
        context: {
          root: this.root,
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
    this.send(error === undefined ? { type: "turn_end", stopReason } : { type: "turn_end", stopReason, error });
  }

  /** Returns why the call may not run, or null when it may. */
  private async authorize(tool: Tool, input: unknown, callId: string, signal: AbortSignal): Promise<string | null> {
    if (this.alwaysAllowed.has(alwaysKey(tool, input))) return null;

    const verdict = checkPermission(this.mode, tool);
    if (verdict.decision === "allow") return null;
    if (verdict.decision === "deny") return verdict.reason;

    // Ask the UI, then wait for its permission_answer or for the turn to be aborted.
    const decision = await new Promise<Decision>((resolve) => {
      this.waitingPermissions.set(callId, resolve);
      signal.addEventListener("abort", () => resolve("deny"), { once: true });
      this.send({ type: "permission_request", callId, tool: tool.name, input, reason: verdict.reason });
    });
    this.waitingPermissions.delete(callId);

    if (signal.aborted) return "the user aborted the turn";
    if (decision === "deny") return "the user denied this call";
    if (decision === "always") this.alwaysAllowed.add(alwaysKey(tool, input));
    return null;
  }

  /** Runs a slash command and reports the outcome as a notice. */
  private async command(name: Command, arg?: string): Promise<void> {
    try {
      this.send({ type: "notice", text: await this.runCommand(name, arg) });
    } catch (err) {
      this.send({ type: "notice", text: (err as Error).message, isError: true });
    }
  }

  private async runCommand(name: Command, arg?: string): Promise<string> {
    if (this.turn) throw new Error(`/${name} cannot run during a turn`);

    if (name === "clear") {
      this.history = [];
      this.reads.clear();
      return "conversation cleared";
    }

    if (name === "undo") {
      const paths = await this.checkpoints.undo();
      if (paths.length === 0) return "nothing to undo";
      // The files changed: make the model read them again before editing.
      for (const path of paths) this.reads.delete(path);
      const list = paths.map((p) => p.replace(this.root + "/", "")).join(", ");
      return `restored ${list}. Changes made through bash are not undone.`;
    }

    if (name === "model") {
      if (!arg) return `model: ${formatModel(this.spec)}`;
      this.spec = parseModel(arg);
      this.model = this.options.createModel(this.spec);
      this.sendSession();
      return `model set to ${arg}`;
    }

    return "compaction is not available yet";
  }

  private sendSession(): void {
    this.send({ type: "session", model: formatModel(this.spec), mode: this.mode });
  }
}
