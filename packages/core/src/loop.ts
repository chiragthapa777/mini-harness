import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { chatModel } from "./provider.js";
import { parseToolCalls, renderToolCatalog, renderToolResults } from "./protocol.js";
import type { AgentTool, RunConfig, RunResult, StopReason, TraceStep, WorkingMemory } from "./types.js";

/** Injection point for tests, and for callers that already hold a model. */
export interface RunDeps {
  model?: BaseChatModel;
}

/**
 * The agentic loop.
 *
 * LangChain supplies one thing: a single chat interface across providers.
 * The loop, the tool-calling protocol, the end-loop guardrails, and the trace
 * are the harness — ours, so behaviour does not change when the provider does.
 */
export async function runAgent(
  wm: WorkingMemory,
  tools: AgentTool[],
  config: RunConfig,
  deps: RunDeps = {},
): Promise<RunResult> {
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

  try {
    for (let iteration = 1; ; iteration++) {
      if (iteration > config.guardrails.maxIterations) {
        stopReason = "max_iterations";
        break;
      }
      if (inputTokens + outputTokens > config.guardrails.maxTokensPerRun) {
        stopReason = "token_budget";
        break;
      }

      const iterationStart = Date.now();
      const response = (await model.invoke(messages)) as AIMessage;

      inputTokens += response.usage_metadata?.input_tokens ?? 0;
      outputTokens += response.usage_metadata?.output_tokens ?? 0;
      messages.push(response);

      const { calls, text } = parseToolCalls(textOf(response));

      if (calls.length === 0) {
        reply = text;
        steps.push(step(iteration, [], response, iterationStart));
        stopReason = finishReason(response) === "length" ? "length" : "end_turn";
        break;
      }

      // Every call gets a result, failures included — a call the model never
      // hears back about tends to be repeated on the next iteration.
      const traced: TraceStep["toolCalls"] = [];
      const results: { id: string; name: string; output: string; isError: boolean }[] = [];

      for (const call of calls) {
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
        traced.push({ name: call.name, input: call.args, isError });
        results.push({ id: call.id, name: call.name, output, isError });
      }

      steps.push(step(iteration, traced, response, iterationStart));
      messages.push(new HumanMessage(renderToolResults(results)));
    }
  } catch (err) {
    stopReason = "error";
    error = err instanceof Error ? err.message : String(err);
  }

  return {
    reply,
    trace: {
      provider: config.provider,
      model: config.model,
      iterations: steps.length,
      inputTokens,
      outputTokens,
      latencyMs: Date.now() - startedAt,
      stopReason,
      error,
      steps,
    },
  };
}

/** Stable prompt first, then the tool catalog, then retrieved memory. */
export function buildSystem(wm: WorkingMemory, tools: AgentTool[]): string {
  const sections: [string, string[]][] = [
    ["How to act", wm.procedural],
    ["What is known", wm.semantic],
    ["What happened before", wm.episodic],
  ];

  const retrieved = sections
    .filter(([, items]) => items.length > 0)
    .map(([heading, items]) => `## ${heading}\n${items.map((i) => `- ${i}`).join("\n")}`);

  return [wm.systemPrompt, renderToolCatalog(tools), ...retrieved]
    .filter(Boolean)
    .join("\n\n");
}

export function textOf(message: AIMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((block: unknown) => {
      if (typeof block === "string") return block;
      const part = block as { type?: string; text?: string };
      return part.type === "text" ? (part.text ?? "") : "";
    })
    .join("");
}

export function finishReason(message: AIMessage): string | undefined {
  const meta = message.response_metadata as Record<string, unknown> | undefined;
  const reason = meta?.["finish_reason"] ?? meta?.["stop_reason"];
  return typeof reason === "string" ? reason : undefined;
}

function step(
  iteration: number,
  toolCalls: TraceStep["toolCalls"],
  response: AIMessage,
  startedAt: number,
): TraceStep {
  return {
    iteration,
    toolCalls,
    inputTokens: response.usage_metadata?.input_tokens ?? 0,
    outputTokens: response.usage_metadata?.output_tokens ?? 0,
    latencyMs: Date.now() - startedAt,
  };
}
