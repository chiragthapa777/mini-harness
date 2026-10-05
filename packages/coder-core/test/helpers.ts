import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatClient, Msg } from "@mini-agent/llm";
import { z } from "zod";
import { Session, type SessionOptions } from "../src/session.js";
import type { Tool } from "../src/tool.js";
import type { SettingsFile } from "../src/settings.js";
import type { Command, CoreMessage, Decision, SettingsScope } from "../src/wire.js";

/**
 * A scripted model reply. A string is streamed in small chunks. `hang`
 * streams its text and then waits until aborted. `fail` throws.
 */
export type Reply = string | { hang: string } | { fail: string };

export function fakeModel(replies: Reply[]) {
  const seen: Msg[][] = []; // the messages of every call
  let calls = 0;

  const client: ChatClient = {
    provider: "openrouter",
    model: "fake",
    invoke: () => Promise.reject(new Error("not used")),
    async *stream(messages, { signal } = {}) {
      seen.push(messages);
      const reply = replies[Math.min(calls++, replies.length - 1)] ?? "";
      if (typeof reply === "object" && "fail" in reply) throw new Error(reply.fail);

      const text = typeof reply === "string" ? reply : reply.hang;
      for (let i = 0; i < text.length; i += 7) {
        signal?.throwIfAborted();
        yield { type: "text", text: text.slice(i, i + 7) };
      }
      if (typeof reply === "object") {
        await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));
      }
      yield { type: "usage", usage: { inputTokens: 100, outputTokens: 10 } };
      yield { type: "finish", reason: "stop" };
    },
  };

  return { client, seen, calls: () => calls };
}

export function toolCall(tool: string, input: object): string {
  return "```tool_call\n" + JSON.stringify({ tool, input }) + "\n```";
}

export async function tempProject(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "coder-core-")));
}

export const echoTool: Tool = {
  name: "echo",
  description: "returns its input",
  kind: "read",
  schema: z.object({ text: z.string() }),
  run: async ({ text }) => `echo: ${text}`,
};

export const shellTool: Tool = {
  name: "shell",
  description: "runs a command",
  kind: "exec",
  schema: z.object({ command: z.string() }),
  async run({ command }, ctx) {
    ctx.onOutput("line 1\n");
    return `ran ${command}`;
  },
};

type PermissionRequest = Extract<CoreMessage, { type: "permission_request" }>;
type Notice = Extract<CoreMessage, { type: "notice" }>;

/**
 * A real Session, driven like a UI would: messages in through `receive`,
 * everything it sends collected in `events`.
 * `answers` reply to permission requests in order ("never" leaves one unanswered).
 */
export async function harness(options: {
  replies: Reply[];
  tools?: Tool[];
  answers?: (Decision | "never")[];
  limits?: SessionOptions["limits"];
  cwd?: string;
  mode?: SessionOptions["mode"];
  model?: string;
  logFile?: string;
  skills?: SessionOptions["skills"];
}) {
  const model = fakeModel(options.replies);
  const events: CoreMessage[] = [];
  const asked: Omit<PermissionRequest, "type">[] = [];
  const answers = [...(options.answers ?? [])];
  const saved: Record<SettingsScope, SettingsFile> = { project: {}, user: {} }; // the settings files, in memory
  let onTurnEnd = () => {};
  let onNotice = (_: Notice) => {};

  const cwd = options.cwd ?? (await tempProject());
  const session: Session = new Session(
    (message) => {
      events.push(message);
      if (message.type === "turn_end") onTurnEnd();
      if (message.type === "notice") onNotice(message);
      if (message.type === "permission_request") {
        const { type, ...request } = message;
        asked.push(request);
        const decision = answers.shift() ?? "deny";
        if (decision !== "never") session.receive({ type: "permission_answer", callId: message.callId, decision });
      }
    },
    {
      cwd,
      tools: options.tools ?? [echoTool],
      createModel: () => model.client,
      limits: options.limits,
      mode: options.mode,
      model: options.model,
      logFile: options.logFile,
      skills: options.skills,
      saveSettings: async (scope, edit) => edit(saved[scope]),
    },
  );

  /** Submits and resolves with the turn_end message. */
  async function turn(text: string) {
    const ended = new Promise<void>((resolve) => (onTurnEnd = resolve));
    session.receive({ type: "submit", text });
    await ended;
    return events.at(-1)!;
  }

  /** Runs a slash command and resolves with the notice it answers with. */
  function command(name: Command, arg?: string) {
    const noticed = new Promise<Notice>((resolve) => (onNotice = resolve));
    session.receive({ type: "command", name, arg });
    return noticed;
  }

  return { session, model, events, asked, saved, cwd, turn, command };
}

/** Events as short strings, without text deltas and usage. */
export function summary(events: CoreMessage[]): string[] {
  const lines: string[] = [];
  for (const e of events) {
    if (e.type === "tool_start") lines.push(`start ${e.name}`);
    if (e.type === "tool_end") lines.push(`end ${e.isError ? "error" : "ok"}: ${e.output}`);
    if (e.type === "turn_end") lines.push(`turn_end ${e.stopReason}`);
  }
  return lines;
}

export function shownText(events: CoreMessage[]): string {
  return events.map((e) => (e.type === "text_delta" ? e.text : "")).join("");
}

export const tick = () => new Promise((resolve) => setImmediate(resolve));
