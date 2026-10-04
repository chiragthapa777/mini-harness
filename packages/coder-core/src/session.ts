import { realpathSync, statSync } from "node:fs";
import type { ChatClient, Msg } from "@mini-agent/llm";
import { Checkpoints } from "./checkpoints.js";
import { alwaysRule, checkPermission, parseRule, type Rules } from "./gate.js";
import { DEFAULT_LIMITS, runLoop, type Limits } from "./loop.js";
import { DEFAULT_MODEL, formatModel, parseModel, type ModelSpec } from "./model.js";
import { buildSystemPrompt, COMPACT_PROMPT } from "./prompt.js";
import { appendRecord, keepForReplay, readRecords, type SessionRecord } from "./sessions.js";
import type { Tool } from "./tool.js";
import type { Command, CoreMessage, Decision, Listed, PermissionMode, StopReason, UiMessage } from "./wire.js";

export interface SessionOptions {
  cwd: string;
  tools: Tool[];
  createModel(spec: ModelSpec): ChatClient;
  model?: string; // "provider:model"
  mode?: PermissionMode;
  /** Permission rules as text, like `bash(npm test:*)`. Deny wins over allow. */
  rules?: { allow?: string[]; deny?: string[] };
  /** Text for the system prompt: AGENTS.md, remembered facts, the skill list. */
  memory?: string;
  /** The skills behind that list. `/name` as a message asks the model to use one. */
  skills?: Listed[];
  /** The session log. A file that already has turns is resumed; without a file nothing is saved. */
  logFile?: string;
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
  private logged = 0; // how many history entries are already in the session log
  private contextTokens = 0; // size of the last model call
  private checkpoints = new Checkpoints();
  private reads = new Map<string, number>(); // file → mtime when read
  private shell: { cwd: string };
  private rules: Rules; // "always" answers add to `allow`
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
    this.rules = {
      allow: (options.rules?.allow ?? []).map(parseRule),
      deny: (options.rules?.deny ?? []).map(parseRule),
    };
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.system = buildSystemPrompt(options.tools, {
      root: this.root,
      platform: process.platform,
      date: new Date().toISOString().slice(0, 10),
      memory: options.memory,
    });
    this.sendSession();

    const records = options.logFile ? readRecords(options.logFile) : [];
    for (const record of records) {
      if (record.reset) this.history = [];
      this.history.push(...record.history);
    }
    this.logged = this.history.length;
    if (records.length > 0) this.send({ type: "replay", messages: records.flatMap((record) => record.messages) });
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

    this.startTurn([{ type: "user", text }], async (emit, signal) => {
      this.checkpoints.begin();
      if (this.contextTokens > this.limits.compactAtTokens) await this.compact(emit, signal);
      this.history.push({ role: "user", content: this.expandSkill(text) });

      return runLoop(this.history, {
        model: this.model,
        tools: this.options.tools,
        system: this.system,
        limits: this.limits,
        signal,
        emit,
        authorize: (tool, input, callId) => this.authorize(tool, input, callId, signal),
        nextCallId: () => `call_${++this.callCount}`,
        context: {
          root: this.root,
          reads: this.reads,
          shell: this.shell,
          checkpoint: (path) => this.checkpoints.save(path),
        },
      });
    });
  }

  /**
   * Runs `work` as the one running turn: turn_start, the work, a line in the
   * session log, turn_end. `shown` collects what a resume will replay.
   */
  private startTurn(
    shown: CoreMessage[],
    work: (emit: (message: CoreMessage) => void, signal: AbortSignal) => Promise<StopReason>,
  ): void {
    const controller = new AbortController();
    const { signal } = controller;
    const emit = (message: CoreMessage) => {
      if (message.type === "usage") this.contextTokens = message.inputTokens + message.outputTokens;
      keepForReplay(shown, message);
      this.send(message);
    };

    const run = async () => {
      this.send({ type: "turn_start" });
      let end: CoreMessage;
      try {
        end = { type: "turn_end", stopReason: await work(emit, signal) };
      } catch (err) {
        end = signal.aborted
          ? { type: "turn_end", stopReason: "aborted" }
          : { type: "turn_end", stopReason: "error", error: (err as Error).message };
      }

      await this.log({ messages: [...shown, end], history: this.history.slice(this.logged) });
      // Free the session first, so the UI can submit as soon as it sees turn_end.
      this.turn = undefined;
      this.send(end);
    };
    this.turn = { controller, done: run() };
  }

  /** Replaces the history with the model's own summary of it. */
  private async compact(emit: (message: CoreMessage) => void, signal: AbortSignal): Promise<void> {
    if (this.history.length === 0) return emit({ type: "notice", text: "nothing to compact" });

    const messages: Msg[] = [
      { role: "system", content: this.system },
      ...this.history,
      { role: "user", content: COMPACT_PROMPT },
    ];
    let summary = "";
    for await (const delta of this.model.stream(messages, { signal })) {
      if (delta.type === "text") summary += delta.text;
    }
    if (!summary.trim()) throw new Error("compaction failed: the model returned no summary");

    const notice: CoreMessage = { type: "notice", text: "conversation compacted" };
    this.history = [
      { role: "user", content: `Summary of the conversation so far:\n\n${summary.trim()}` },
      { role: "assistant", content: "Understood. I will continue from this summary." },
    ];
    this.contextTokens = 0;
    await this.log({ reset: true, messages: [notice], history: this.history });
    emit(notice);
  }

  /** Appends to the session log. A failed write is reported, never fatal: the session goes on unsaved. */
  private async log(record: Omit<SessionRecord, "at">): Promise<void> {
    this.logged = this.history.length;
    if (!this.options.logFile) return;
    try {
      await appendRecord(this.options.logFile, record);
    } catch (err) {
      this.send({ type: "notice", text: `could not save the session: ${(err as Error).message}`, isError: true });
    }
  }

  /** Returns why the call may not run, or null when it may. */
  private async authorize(tool: Tool, input: unknown, callId: string, signal: AbortSignal): Promise<string | null> {
    const verdict = checkPermission(this.mode, tool, input, this.rules);
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
    if (decision === "always") this.rules.allow.push(alwaysRule(tool, input));
    return null;
  }

  /** Runs a slash command and reports the outcome as a notice. */
  private async command(name: Command, arg?: string): Promise<void> {
    if (name === "compact" && !this.turn) {
      // A turn of its own: it calls the model, so it can be watched and interrupted like one.
      return this.startTurn([], async (emit, signal) => {
        await this.compact(emit, signal);
        return "end_turn";
      });
    }
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
      this.contextTokens = 0;
      await this.log({ reset: true, messages: [{ type: "notice", text: "conversation cleared" }], history: [] });
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

    throw new Error(`unknown command /${name}`);
  }

  /** `/release 1.2` becomes an instruction to load and follow the `release` skill. The screen and the log keep what was typed. */
  private expandSkill(text: string): string {
    const [, name, rest = ""] = /^\/([\w-]+)\s*(.*)$/s.exec(text) ?? [];
    if (!this.options.skills?.some((skill) => skill.name === name)) return text;
    return `Use the "${name}" skill: load it with the skill tool, then follow it.\n\n${rest}`.trim();
  }

  private sendSession(): void {
    this.send({
      type: "session",
      model: formatModel(this.spec),
      mode: this.mode,
      tools: this.options.tools.map(({ name, description }) => ({ name, description })),
      skills: this.options.skills ?? [],
    });
  }
}
