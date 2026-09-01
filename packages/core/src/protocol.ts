import { z } from "zod";
import type { AgentTool } from "./types.js";

/**
 * Our own tool-calling protocol.
 *
 * `@mini-agent/llm` is the chat transport and nothing more — no provider-native
 * function calling, no tool schemas on the wire. The agent asks for a tool by
 * emitting a fenced `tool_call` block; the harness parses it, runs the handler,
 * and feeds the result back. One wire format across every provider, and the
 * exact bytes are ours to trace and replay.
 */
export const TOOL_CALL_FENCE = "tool_call";

export interface ParsedToolCall {
  id: string;
  name: string;
  args: unknown;
  raw: string;
}

const callShape = z.object({
  tool: z.string(),
  input: z.record(z.string(), z.unknown()).default({}),
});

/** Rendered into the system prompt so the model knows the format and the tools. */
export function renderToolCatalog(tools: AgentTool[]): string {
  if (tools.length === 0) return "";

  const catalog = tools
    .map((t) => {
      const schema = JSON.stringify(z.toJSONSchema(t.schema));
      return `### ${t.name}\n${t.description}\ninput schema: ${schema}`;
    })
    .join("\n\n");

  return [
    "## Tools",
    "",
    "To use a tool, reply with nothing but one or more fenced blocks:",
    "",
    "```" + TOOL_CALL_FENCE,
    '{"tool": "<name>", "input": { ... }}',
    "```",
    "",
    "Each block holds exactly one JSON object. Emit several blocks to call",
    "several tools at once. Tool results come back in the next user message.",
    "When you have what you need, answer normally with no tool_call block.",
    "",
    catalog,
  ].join("\n");
}

const FENCE_PATTERN = new RegExp("```" + TOOL_CALL_FENCE + "\\s*\\n([\\s\\S]*?)```", "g");

/** Pulls tool calls out of a model reply, and returns the text without them. */
export function parseToolCalls(text: string): { calls: ParsedToolCall[]; text: string } {
  const calls: ParsedToolCall[] = [];
  let index = 0;

  for (const match of text.matchAll(FENCE_PATTERN)) {
    const body = match[1]?.trim();
    if (!body) continue;

    // A malformed block is surfaced to the model as an error result rather
    // than thrown — it can correct itself on the next iteration.
    let name = "unparseable";
    let args: unknown = {};
    let raw = body;
    try {
      const parsed = callShape.parse(JSON.parse(body));
      name = parsed.tool;
      args = parsed.input;
    } catch (err) {
      raw = err instanceof Error ? `${body}\n${err.message}` : body;
    }

    calls.push({ id: `call_${++index}`, name, args, raw });
  }

  return { calls, text: text.replace(FENCE_PATTERN, "").trim() };
}

const FENCE_OPEN = "```" + TOOL_CALL_FENCE;

/**
 * Streams text to the user while hiding tool_call blocks as they arrive.
 *
 * Tokens arrive one at a time, so a fence can only be recognised part-way
 * through. The filter holds back the last few characters until they are
 * unambiguous, which is why `flush()` must be called at the end of a turn.
 */
export class ToolCallTextFilter {
  #buffer = "";
  #inFence = false;

  /** Feed a token; returns the text that is safe to show the user. */
  push(chunk: string): string {
    this.#buffer += chunk;
    let out = "";

    for (;;) {
      if (this.#inFence) {
        const close = this.#buffer.indexOf("```");
        if (close === -1) return out;
        this.#buffer = this.#buffer.slice(close + 3);
        this.#inFence = false;
        continue;
      }

      const open = this.#buffer.indexOf("```");
      if (open === -1) {
        // Hold back a possible partial fence marker.
        const keep = Math.min(this.#buffer.length, FENCE_OPEN.length);
        out += this.#buffer.slice(0, this.#buffer.length - keep);
        this.#buffer = this.#buffer.slice(this.#buffer.length - keep);
        return out;
      }

      const rest = this.#buffer.slice(open);
      if (rest.length < FENCE_OPEN.length && FENCE_OPEN.startsWith(rest)) {
        // Could still become a tool_call fence — wait for more tokens.
        out += this.#buffer.slice(0, open);
        this.#buffer = rest;
        return out;
      }

      out += this.#buffer.slice(0, open);
      if (rest.startsWith(FENCE_OPEN)) {
        this.#buffer = rest.slice(FENCE_OPEN.length);
        this.#inFence = true;
      } else {
        // An ordinary code fence: let it through.
        out += "```";
        this.#buffer = rest.slice(3);
      }
    }
  }

  /** Whatever is still held back once the turn is over. */
  flush(): string {
    if (this.#inFence) {
      this.#buffer = "";
      return "";
    }
    const out = this.#buffer;
    this.#buffer = "";
    return out;
  }
}

/** Tool results go back as a plain user turn — no provider tool role involved. */
export function renderToolResults(
  results: { id: string; name: string; output: string; isError: boolean }[],
): string {
  return results
    .map(
      ({ id, name, output, isError }) =>
        `[${id}] ${name} ${isError ? "error" : "result"}:\n${output}`,
    )
    .join("\n\n");
}
