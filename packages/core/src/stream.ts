import type { AIMessageChunk } from "@langchain/core/messages";
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { buildSystem, type RunDeps } from "./loop.js";
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
  const model =
    deps.model ?? (await chatModel(config.provider, config.model, config.maxTokens));

  const messages: BaseMessage[] = [
    new SystemMessage(buildSystem(wm, tools)),
    ...wm.history,
    new HumanMessage(wm.userPrompt),
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

      for await (const chunk of await model.stream(messages)) {
        const thinking = thinkingOf(chunk);
        if (thinking) yield { type: "thinking_delta", text: thinking };

        const text = chunkText(chunk);
        if (text) {
          raw += text;
          // Tool-call blocks are machinery, not prose — keep them off screen.
          const visible = filter.push(text);
          if (visible) yield { type: "text_delta", text: visible };
        }

        stepInput += chunk.usage_metadata?.input_tokens ?? 0;
        stepOutput += chunk.usage_metadata?.output_tokens ?? 0;
        finish = finishOf(chunk) ?? finish;
      }

      const tail = filter.flush();
      if (tail) yield { type: "text_delta", text: tail };

      inputTokens += stepInput;
      outputTokens += stepOutput;
      messages.push(new AIMessage(raw));

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
        stopReason = finish === "length" ? "length" : "end_turn";
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
      messages.push(new HumanMessage(renderToolResults(results)));
    }
  } catch (err) {
    stopReason = "error";
    error = err instanceof Error ? err.message : String(err);
    yield { type: "error", message: error };
  }

  const trace: Trace = {
    provider: config.provider,
    model: config.model,
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

function chunkText(chunk: AIMessageChunk): string {
  if (typeof chunk.content === "string") return chunk.content;
  return chunk.content
    .map((block: unknown) => {
      if (typeof block === "string") return block;
      const part = block as { type?: string; text?: string };
      return part.type === "text" ? (part.text ?? "") : "";
    })
    .join("");
}

/**
 * Reasoning tokens have no standard field yet — OpenRouter sends
 * `reasoning`, OpenAI-compatible hosts often send `reasoning_content`, and
 * Anthropic uses a `thinking` content block.
 */
function thinkingOf(chunk: AIMessageChunk): string {
  const extra = chunk.additional_kwargs as Record<string, unknown> | undefined;
  const direct = extra?.["reasoning_content"] ?? extra?.["reasoning"];
  if (typeof direct === "string" && direct) return direct;

  // OpenRouter puts reasoning on `delta.reasoning`, which LangChain drops from
  // the parsed chunk — hence the raw response passthrough.
  const raw = extra?.["__raw_response"] as
    | { choices?: { delta?: { reasoning?: string; reasoning_content?: string } }[] }
    | undefined;
  const delta = raw?.choices?.[0]?.delta;
  const fromRaw = delta?.reasoning ?? delta?.reasoning_content;
  if (typeof fromRaw === "string" && fromRaw) return fromRaw;

  if (Array.isArray(chunk.content)) {
    return chunk.content
      .map((block: unknown) => {
        const part = block as { type?: string; thinking?: string; text?: string };
        return part?.type === "thinking" ? (part.thinking ?? part.text ?? "") : "";
      })
      .join("");
  }
  return "";
}

function finishOf(chunk: AIMessageChunk): string | undefined {
  const meta = chunk.response_metadata as Record<string, unknown> | undefined;
  const reason = meta?.["finish_reason"] ?? meta?.["stop_reason"];
  return typeof reason === "string" ? reason : undefined;
}
