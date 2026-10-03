import type { CoreEvent, StopReason } from "@mini-agent/coder-protocol";
import { ToolCallTextFilter, parseToolCalls, renderToolResults } from "@mini-agent/core/protocol";
import type { ChatClient, Msg } from "@mini-agent/llm";
import type { Tool, ToolContext } from "./tool.js";

/** End-loop guardrails. Required on every loop in this repo. */
export interface Limits {
  /** Model calls per user turn. */
  maxIterations: number;
  /** Input + output tokens summed over a turn's model calls. */
  maxTokensPerTurn: number;
  /** A tool result longer than this keeps its head and tail. */
  maxToolOutputChars: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxIterations: 100,
  maxTokensPerTurn: 2_000_000,
  maxToolOutputChars: 30_000,
};

export type Authorization = { allowed: true } | { allowed: false; reason: string };

export interface LoopOptions {
  model: ChatClient;
  tools: Tool[];
  system: string;
  limits: Limits;
  signal: AbortSignal;
  emit(event: CoreEvent): void;
  /** Gate + user. Resolves once the call may run or has been refused. */
  authorize(tool: Tool, input: unknown, callId: string): Promise<Authorization>;
  /** Session-wide ids, so a UI can key tool cards across turns. */
  nextCallId(): string;
  /** The tool context minus the per-call fields. */
  context: Omit<ToolContext, "signal" | "onOutput">;
}

export interface LoopResult {
  stopReason: StopReason;
}

interface Result {
  id: string;
  name: string;
  output: string;
  isError: boolean;
}

/**
 * One user turn: call the model, run its tool calls, append the results
 * (errors included), and repeat until a reply has no tool calls. `history`
 * is mutated in place — it is the session's, and the caller already pushed
 * the user's message onto it.
 */
export async function runLoop(history: Msg[], options: LoopOptions): Promise<LoopResult> {
  const { model, limits, signal, emit } = options;
  const byName = new Map(options.tools.map((tool) => [tool.name, tool]));
  let tokens = 0;

  for (let iteration = 1; ; iteration++) {
    if (signal.aborted) return { stopReason: "aborted" };
    if (iteration > limits.maxIterations) return { stopReason: "max_iterations" };
    if (tokens > limits.maxTokensPerTurn) return { stopReason: "token_budget" };

    const filter = new ToolCallTextFilter();
    let raw = "";
    let visible = "";
    let finish: string | undefined;

    const show = (text: string) => {
      if (!text) return;
      visible += text;
      emit({ type: "text_delta", text });
    };

    try {
      const messages: Msg[] = [{ role: "system", content: options.system }, ...history];
      for await (const delta of model.stream(messages, { signal })) {
        if (delta.type === "text") {
          raw += delta.text;
          // tool_call blocks are machinery; only prose reaches the screen.
          show(filter.push(delta.text));
        } else if (delta.type === "thinking") {
          emit({ type: "thinking_delta", text: delta.text });
        } else if (delta.type === "usage") {
          tokens += delta.usage.inputTokens + delta.usage.outputTokens;
          emit({ type: "usage", ...delta.usage });
        } else {
          finish = delta.reason;
        }
      }
      show(filter.flush());
    } catch (err) {
      if (!signal.aborted) throw err;
      // The filter holds back a few characters in case they open a fence;
      // ordinary prose among them is shown now rather than lost.
      show(filter.flush());
      // Keep what the user saw, so the model knows where it was cut off.
      history.push({ role: "assistant", content: `${visible}\n\n[interrupted by the user]`.trim() });
      return { stopReason: "aborted" };
    }

    history.push({ role: "assistant", content: raw });
    const { calls } = parseToolCalls(raw);

    if (calls.length === 0) {
      return { stopReason: truncated(finish) ? "length" : "end_turn" };
    }

    const results: Result[] = [];
    for (const call of calls) {
      const id = options.nextCallId();
      if (signal.aborted) {
        results.push({ id, name: call.name, output: "cancelled: the user aborted the turn", isError: true });
        continue;
      }
      results.push(await runCall(call, id, byName, options));
    }

    history.push({ role: "user", content: renderToolResults(results) });
    if (signal.aborted) return { stopReason: "aborted" };
  }
}

async function runCall(
  call: { name: string; args: unknown; raw: string },
  id: string,
  byName: Map<string, Tool>,
  options: LoopOptions,
): Promise<Result> {
  const { emit, signal } = options;
  const fail = (output: string): Result => {
    emit({ type: "tool_end", callId: id, output, isError: true });
    return { id, name: call.name, output, isError: true };
  };

  const tool = byName.get(call.name);
  if (!tool) {
    emit({ type: "tool_start", callId: id, name: call.name, input: call.args });
    return fail(
      call.name === "unparseable"
        ? `could not parse the tool_call block:\n${call.raw}`
        : `unknown tool "${call.name}". Available: ${[...byName.keys()].join(", ")}`,
    );
  }

  const parsed = tool.schema.safeParse(call.args);
  if (!parsed.success) {
    emit({ type: "tool_start", callId: id, name: call.name, input: call.args });
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
      .join("; ");
    return fail(`invalid input for ${tool.name}: ${issues}`);
  }

  // Ask before the card appears as running: the UI shows the prompt first.
  const authorization = await options.authorize(tool, parsed.data, id);
  emit({ type: "tool_start", callId: id, name: tool.name, input: parsed.data });
  if (!authorization.allowed) return fail(`not run: ${authorization.reason}`);

  try {
    const output = await tool.run(parsed.data, {
      ...options.context,
      signal,
      onOutput: (chunk) => emit({ type: "tool_output", callId: id, chunk }),
    });
    const capped = capOutput(output, options.limits.maxToolOutputChars);
    emit({ type: "tool_end", callId: id, output: capped, isError: false });
    return { id, name: tool.name, output: capped, isError: false };
  } catch (err) {
    const message = signal.aborted
      ? "cancelled: the user aborted the turn"
      : err instanceof Error
        ? err.message
        : String(err);
    return fail(capOutput(message, options.limits.maxToolOutputChars));
  }
}

/** Keeps the head and the tail: errors and summaries tend to sit at the end of output. */
export function capOutput(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  const dropped = text.length - half * 2;
  return `${text.slice(0, half)}\n\n[… ${dropped} characters omitted …]\n\n${text.slice(-half)}`;
}

/** Each provider names "ran out of output tokens" differently. */
function truncated(reason: string | undefined): boolean {
  const value = reason?.toLowerCase();
  return value === "length" || value === "max_tokens";
}
