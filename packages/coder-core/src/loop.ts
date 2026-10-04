import type { CoreMessage, StopReason } from "./wire.js";
import { ToolCallTextFilter, parseToolCalls, renderToolResults } from "@mini-agent/core/protocol";
import type { ChatClient, Msg } from "@mini-agent/llm";
import type { Tool, ToolContext } from "./tool.js";

/** Guardrails: every loop in this repo must have them. */
export interface Limits {
  maxIterations: number; // model calls per user turn
  maxTokensPerTurn: number; // input + output tokens over the turn
  maxToolOutputChars: number; // longer tool results keep head and tail
}

export const DEFAULT_LIMITS: Limits = {
  maxIterations: 100,
  maxTokensPerTurn: 2_000_000,
  maxToolOutputChars: 30_000,
};

export interface LoopOptions {
  model: ChatClient;
  tools: Tool[];
  system: string;
  limits: Limits;
  signal: AbortSignal;
  emit(message: CoreMessage): void;
  /** Returns why the call may not run, or null when it may. */
  authorize(tool: Tool, input: unknown, callId: string): Promise<string | null>;
  nextCallId(): string;
  context: Omit<ToolContext, "signal" | "onOutput">;
}

/**
 * One user turn. Call the model, run its tool calls, add the results to the
 * history, and repeat until the model replies without a tool call.
 * `history` already ends with the user's message and is updated in place.
 */
export async function runLoop(history: Msg[], options: LoopOptions): Promise<StopReason> {
  const { limits, signal } = options;
  let tokens = 0;

  for (let iteration = 1; ; iteration++) {
    if (signal.aborted) return "aborted";
    if (iteration > limits.maxIterations) return "max_iterations";
    if (tokens > limits.maxTokensPerTurn) return "token_budget";

    const reply = await streamReply(history, options);
    if (!reply) return "aborted";
    tokens += reply.tokens;
    history.push({ role: "assistant", content: reply.text });

    const { calls } = parseToolCalls(reply.text);
    if (calls.length === 0) {
      const finish = reply.finish?.toLowerCase();
      return finish === "length" || finish === "max_tokens" ? "length" : "end_turn";
    }

    const results = [];
    for (const call of calls) {
      const id = options.nextCallId();
      const result = signal.aborted
        ? { output: "cancelled: the user aborted the turn", isError: true }
        : await runCall(call, id, options);
      results.push({ id, name: call.name, ...result });
    }
    history.push({ role: "user", content: renderToolResults(results) });
  }
}

/** Streams one model reply to the UI. Returns null if the user aborted it. */
async function streamReply(history: Msg[], options: LoopOptions) {
  const { emit, signal } = options;
  const filter = new ToolCallTextFilter(); // hides tool_call blocks from the screen
  let text = "";
  let shown = "";
  let tokens = 0;
  let finish: string | undefined;

  const show = (chunk: string) => {
    if (!chunk) return;
    shown += chunk;
    emit({ type: "text_delta", text: chunk });
  };

  try {
    const messages: Msg[] = [{ role: "system", content: options.system }, ...history];
    for await (const delta of options.model.stream(messages, { signal })) {
      if (delta.type === "text") {
        text += delta.text;
        show(filter.push(delta.text));
      } else if (delta.type === "thinking") {
        emit({ type: "thinking_delta", text: delta.text });
      } else if (delta.type === "usage") {
        tokens = delta.usage.inputTokens + delta.usage.outputTokens;
        emit({ type: "usage", ...delta.usage });
      } else {
        finish = delta.reason;
      }
    }
    show(filter.flush());
    return { text, tokens, finish };
  } catch (err) {
    if (!signal.aborted) throw err;
    // Keep what the user saw, so the model knows where it was cut off.
    show(filter.flush());
    history.push({ role: "assistant", content: `${shown}\n\n[interrupted by the user]`.trim() });
    return null;
  }
}

/** Runs one tool call. Every problem becomes an error result for the model, never an exception. */
async function runCall(
  call: { name: string; args: unknown; raw: string },
  id: string,
  options: LoopOptions,
): Promise<{ output: string; isError: boolean }> {
  const { emit } = options;
  const start = (input: unknown) => emit({ type: "tool_start", callId: id, name: call.name, input });
  const end = (output: string, isError: boolean) => {
    output = capOutput(output, options.limits.maxToolOutputChars);
    emit({ type: "tool_end", callId: id, output, isError });
    return { output, isError };
  };

  const tool = options.tools.find((t) => t.name === call.name);
  if (!tool) {
    start(call.args);
    if (call.name === "unparseable") return end(`could not parse the tool_call block:\n${call.raw}`, true);
    const names = options.tools.map((t) => t.name).join(", ");
    return end(`unknown tool "${call.name}". Available: ${names}`, true);
  }

  const parsed = tool.schema.safeParse(call.args);
  if (!parsed.success) {
    start(call.args);
    const issue = parsed.error.issues[0];
    return end(`invalid input for ${tool.name}: ${issue?.path.join(".")} ${issue?.message}`, true);
  }

  // Ask first: the UI shows the permission prompt before the tool card.
  const refused = await options.authorize(tool, parsed.data, id);
  start(parsed.data);
  if (refused) return end(`not run: ${refused}`, true);

  try {
    const output = await tool.run(parsed.data, {
      ...options.context,
      signal: options.signal,
      onOutput: (chunk) => emit({ type: "tool_output", callId: id, chunk }),
    });
    return end(output, false);
  } catch (err) {
    return end(options.signal.aborted ? "cancelled: the user aborted the turn" : (err as Error).message, true);
  }
}

/** Keeps the start and the end: errors and summaries are usually at the end. */
export function capOutput(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  const omitted = text.length - half * 2;
  return `${text.slice(0, half)}\n\n[… ${omitted} characters omitted …]\n\n${text.slice(-half)}`;
}
