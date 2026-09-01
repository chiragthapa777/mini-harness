import type { Msg } from "@mini-agent/llm";
import { buildSystem, truncated, type RunDeps } from "./loop.js";
import { chatModel } from "./provider.js";
import { ToolCallTextFilter, parseToolCalls, renderToolResults } from "./protocol.js";
import type {
  AgentTool,
  RunConfig,
  RunEvent,
  StopReason,
  Trace,
  TraceStep,
  WorkingMemory,
} from "./types.js";

/**
 * The streaming twin of `runAgent`. Same protocol, same guardrails, same
 * trace — but it yields the run as it happens instead of returning at the end,
 * so a client can watch thinking, tool calls, and text arrive live.
 *
 * `runAgent` is deliberately left alone: the non-streaming path stays the
 * simplest thing that works, and providers that cannot stream still use it.
 */
export async function* runAgentStream(
  wm: WorkingMemory,
  tools: AgentTool[],
  config: RunConfig,
  deps: RunDeps = {},
): AsyncGenerator<RunEvent, void, undefined> {
  const startedAt = Date.now();
  const byName = new Map(tools.map((t) => [t.name, t]));
  const model = deps.model ?? chatModel(config.provider, config.model, config.maxTokens);

  const systemPrompt = buildSystem(wm, tools);
  const messages: Msg[] = [
    { role: "system", content: systemPrompt },
    ...wm.history,
    { role: "user", content: wm.userPrompt },
  ];

  const steps: TraceStep[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason: StopReason = "end_turn";
  let error: string | undefined;
  let reply = "";

  yield { type: "run_start", provider: config.provider, model: config.model };

  try {
    for (let iteration = 1; ; iteration++) {
      if (iteration > config.guardrails.maxIterations) {
        stopReason = "max_iterations";
        yield { type: "guardrail", reason: stopReason };
        break;
      }
      if (inputTokens + outputTokens > config.guardrails.maxTokensPerRun) {
        stopReason = "token_budget";
        yield { type: "guardrail", reason: stopReason };
        break;
      }

      yield { type: "iteration_start", iteration };

      const iterationStart = Date.now();
      const filter = new ToolCallTextFilter();
      let raw = "";
      let stepInput = 0;
      let stepOutput = 0;
      let finish: string | undefined;

      for await (const delta of model.stream(messages)) {
        if (delta.type === "thinking") {
          yield { type: "thinking_delta", text: delta.text };
        } else if (delta.type === "text") {
          raw += delta.text;
          // Tool-call blocks are machinery, not prose — keep them off screen.
          const visible = filter.push(delta.text);
          if (visible) yield { type: "text_delta", text: visible };
        } else if (delta.type === "usage") {
          // Adapters emit this once, with run totals for the turn.
          stepInput = delta.usage.inputTokens;
          stepOutput = delta.usage.outputTokens;
        } else {
          finish = delta.reason;
        }
      }

      const tail = filter.flush();
      if (tail) yield { type: "text_delta", text: tail };

      inputTokens += stepInput;
      outputTokens += stepOutput;
      messages.push({ role: "assistant", content: raw });

      const { calls, text } = parseToolCalls(raw);

      yield {
        type: "iteration_end",
        iteration,
        inputTokens: stepInput,
        outputTokens: stepOutput,
      };

      if (calls.length === 0) {
        reply = text;
        steps.push({
          iteration,
          toolCalls: [],
          inputTokens: stepInput,
          outputTokens: stepOutput,
          latencyMs: Date.now() - iterationStart,
        });
        stopReason = truncated(finish) ? "length" : "end_turn";
        break;
      }

      const traced: TraceStep["toolCalls"] = [];
      const results: { id: string; name: string; output: string; isError: boolean }[] = [];

      for (const call of calls) {
        yield { type: "tool_call", id: call.id, name: call.name, input: call.args };

        const handler = byName.get(call.name);
        let output: string;
        let isError = false;
        try {
          if (!handler) throw new Error(`unknown tool: ${call.name} (raw: ${call.raw})`);
          output = await handler.run(handler.schema.parse(call.args));
        } catch (err) {
          output = err instanceof Error ? err.message : String(err);
          isError = true;
        }

        yield { type: "tool_result", id: call.id, name: call.name, output, isError };
        traced.push({ name: call.name, input: call.args, isError });
        results.push({ id: call.id, name: call.name, output, isError });
      }

      steps.push({
        iteration,
        toolCalls: traced,
        inputTokens: stepInput,
        outputTokens: stepOutput,
        latencyMs: Date.now() - iterationStart,
      });
      messages.push({ role: "user", content: renderToolResults(results) });
    }
  } catch (err) {
    stopReason = "error";
    error = err instanceof Error ? err.message : String(err);
    yield { type: "error", message: error };
  }

  const trace: Trace = {
    provider: config.provider,
    model: config.model,
    systemPrompt,
    iterations: steps.length,
    inputTokens,
    outputTokens,
    latencyMs: Date.now() - startedAt,
    stopReason,
    error,
    steps,
  };

  yield { type: "reply", text: reply };
  yield { type: "trace", trace };
}

