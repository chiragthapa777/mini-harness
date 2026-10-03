import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreEndpoint, UiEndpoint, memoryConnections, type CoreEvent, type PermissionParams } from "@mini-agent/coder-protocol";
import type { ChatClient, Msg } from "@mini-agent/llm";
import { z } from "zod";
import { Session, type SessionOptions } from "../src/session.js";
import type { Tool } from "../src/tool.js";

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

/**
 * A real Session behind real endpoints, driven like a UI would.
 * `answers` reply to permission requests in order ("never" leaves one unanswered).
 */
export async function harness(options: {
  replies: Reply[];
  tools?: Tool[];
  answers?: ("allow" | "deny" | "always" | "never")[];
  limits?: SessionOptions["limits"];
  cwd?: string;
  mode?: "default" | "accept-edits" | "plan" | "bypass";
  model?: string;
}) {
  const wires = memoryConnections();
  const ui = new UiEndpoint(wires.ui);
  const model = fakeModel(options.replies);
  const events: CoreEvent[] = [];
  const asked: PermissionParams[] = [];
  const answers = [...(options.answers ?? [])];
  let shutdowns = 0;

  const session = new Session(new CoreEndpoint(wires.core), {
    tools: options.tools ?? [echoTool],
    createModel: () => model.client,
    limits: options.limits,
    onShutdown: () => shutdowns++,
  });

  let onTurnEnd = () => {};
  ui.onEvent((event) => {
    events.push(event);
    if (event.type === "turn_end") onTurnEnd();
  });
  ui.onPermission((params) => {
    asked.push(params);
    const answer = answers.shift() ?? "deny";
    return answer === "never" ? new Promise(() => {}) : { decision: answer };
  });

  const cwd = options.cwd ?? (await tempProject());
  const init = await ui.initialize({ cwd, mode: options.mode, model: options.model });

  /** Submits and resolves with the turn_end event. */
  async function turn(text: string) {
    const ended = new Promise<void>((resolve) => (onTurnEnd = resolve));
    await ui.submit(text);
    await ended;
    return events.at(-1)!;
  }

  return { ui, session, model, events, asked, cwd, init, turn, wires, shutdowns: () => shutdowns };
}

/** Events as short strings, without text deltas and usage. */
export function summary(events: CoreEvent[]): string[] {
  const lines: string[] = [];
  for (const e of events) {
    if (e.type === "tool_start") lines.push(`start ${e.name}`);
    if (e.type === "tool_end") lines.push(`end ${e.isError ? "error" : "ok"}: ${e.output}`);
    if (e.type === "turn_end") lines.push(`turn_end ${e.stopReason}`);
  }
  return lines;
}

export function shownText(events: CoreEvent[]): string {
  return events.map((e) => (e.type === "text_delta" ? e.text : "")).join("");
}

export const tick = () => new Promise((resolve) => setImmediate(resolve));
