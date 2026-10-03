import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CoreEndpoint,
  UiEndpoint,
  memoryConnections,
  type CoreEvent,
  type PermissionParams,
  type PermissionResult,
} from "@mini-agent/coder-protocol";
import type { ChatClient, Delta, Msg } from "@mini-agent/llm";
import { z } from "zod";
import { Session, type SessionDeps } from "../src/session.js";
import type { Tool } from "../src/tool.js";

/**
 * One scripted model reply. A string streams as text in small chunks — small
 * enough to split a tool_call fence across deltas. `hang` streams its text
 * and then waits until the call is aborted; `fail` throws a provider error.
 */
export type Reply = string | { hang: string } | { fail: string };

export function fakeModel(replies: Reply[]) {
  const seen: Msg[][] = [];
  let index = 0;

  const client: ChatClient = {
    provider: "openrouter",
    model: "fake",
    async invoke() {
      throw new Error("the loop streams; invoke is not used");
    },
    async *stream(messages, options = {}): AsyncGenerator<Delta, void, undefined> {
      seen.push(messages.map((m) => ({ ...m })));
      const reply = replies[Math.min(index++, replies.length - 1)] ?? "";
      const signal = options.signal;

      if (typeof reply === "object" && "fail" in reply) throw new Error(reply.fail);
      const text = typeof reply === "string" ? reply : reply.hang;

      for (let i = 0; i < text.length; i += 7) {
        signal?.throwIfAborted();
        yield { type: "text", text: text.slice(i, i + 7) };
      }

      if (typeof reply === "object") {
        await new Promise((_, reject) => {
          if (signal?.aborted) reject(signal.reason);
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }

      yield { type: "usage", usage: { inputTokens: 100, outputTokens: 10 } };
      yield { type: "finish", reason: "stop" };
    },
  };

  return { client, seen, calls: () => index };
}

export function toolCall(tool: string, input: Record<string, unknown>): string {
  return "```tool_call\n" + JSON.stringify({ tool, input }) + "\n```";
}

/** A temp directory that stands in for the project root. */
export async function tempProject(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "coder-core-")));
}

export const echoTool: Tool = {
  name: "echo",
  description: "returns its input",
  kind: "read",
  schema: z.object({ text: z.string() }),
  async run({ text }) {
    return `echo: ${text}`;
  },
};

export function writeTool(onRun: (input: { path: string; content: string }, ctx: Parameters<Tool["run"]>[1]) => Promise<void>): Tool {
  return {
    name: "write",
    description: "writes a file",
    kind: "write",
    schema: z.object({ path: z.string(), content: z.string() }),
    async run(input, ctx) {
      await onRun(input as { path: string; content: string }, ctx);
      return `wrote ${(input as { path: string }).path}`;
    },
  };
}

export const shellTool: Tool = {
  name: "shell",
  description: "runs a command",
  kind: "exec",
  schema: z.object({ command: z.string() }),
  async run({ command }, ctx) {
    ctx.onOutput("line 1\n");
    ctx.onOutput("line 2\n");
    return `ran ${command}`;
  },
};

type Answer = PermissionResult["decision"] | "never";

/**
 * A real Session behind a real endpoint pair, driven by a scripted UI.
 * `answers` are consumed in order as permission requests arrive.
 */
export async function harness(options: {
  replies: Reply[];
  tools?: Tool[];
  answers?: Answer[];
  deps?: Partial<SessionDeps>;
  init?: Partial<Parameters<UiEndpoint["initialize"]>[0]>;
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
    onShutdown: () => shutdowns++,
    now: () => new Date("2026-10-03T12:00:00Z"),
    ...options.deps,
  });

  const waiters: { predicate: (e: CoreEvent) => boolean; resolve: () => void }[] = [];
  ui.onEvent((event) => {
    events.push(event);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(event)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  });
  ui.onPermission((params) => {
    asked.push(params);
    const answer = answers.shift() ?? "deny";
    if (answer === "never") return new Promise(() => {});
    return { decision: answer };
  });

  const root = options.init?.cwd ?? (await tempProject());
  const init = await ui.initialize({ cwd: root, ...options.init });

  /** Resolves on the next event matching `predicate`. */
  const next = (predicate: (e: CoreEvent) => boolean) =>
    new Promise<void>((resolve) => waiters.push({ predicate, resolve }));

  /** Submits and waits for that turn's end. */
  async function turn(text: string) {
    const ended = next((e) => e.type === "turn_end");
    await ui.request("submit", { text });
    await ended;
    return events.at(-1) as Extract<CoreEvent, { type: "turn_end" }>;
  }

  return { ui, session, model, events, asked, root, init, next, turn, wires, shutdowns: () => shutdowns };
}

/** The event stream minus deltas and usage, which vary with chunking. */
export function shape(events: CoreEvent[]): string[] {
  return events
    .filter((e) => e.type !== "text_delta" && e.type !== "usage" && e.type !== "thinking_delta")
    .map((e) => {
      switch (e.type) {
        case "tool_start":
          return `tool_start ${e.name}`;
        case "tool_output":
          return `tool_output ${JSON.stringify(e.chunk)}`;
        case "tool_end":
          return `tool_end ${e.isError ? "error" : "ok"}: ${e.output}`;
        case "turn_end":
          return `turn_end ${e.stopReason}${e.error ? `: ${e.error}` : ""}`;
        default:
          return e.type;
      }
    });
}

export function text(events: CoreEvent[]): string {
  return events.map((e) => (e.type === "text_delta" ? e.text : "")).join("");
}
