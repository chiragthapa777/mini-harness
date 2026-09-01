import type { ChatClient, Completion, Msg } from "@mini-agent/llm";
import { chatModel } from "./provider.js";
import { parseToolCalls, renderToolCatalog, renderToolResults } from "./protocol.js";
import type { AgentTool, RunConfig, RunResult, StopReason, TraceStep, WorkingMemory } from "./types.js";

/** Injection point for tests, and for callers that already hold a model. */
export interface RunDeps {
  model?: ChatClient;
}

/**
 * The agentic loop.
 *
 * `@mini-agent/llm` supplies one thing: a single chat interface across
 * providers. The loop, the tool-calling protocol, the end-loop guardrails, and
 * the trace are the harness — ours, so behaviour does not change when the
 * provider does.
 */
export async function runAgent(
  wm: WorkingMemory,
  tools: AgentTool[],
  config: RunConfig,
  deps: RunDeps = {},
): Promise<RunResult> {
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
      const response = await model.invoke(messages);

      inputTokens += response.usage.inputTokens;
      outputTokens += response.usage.outputTokens;
      messages.push({ role: "assistant", content: response.text });

      const { calls, text } = parseToolCalls(response.text);

      if (calls.length === 0) {
        reply = text;
        steps.push(step(iteration, [], response, iterationStart));
        stopReason = truncated(response.finishReason) ? "length" : "end_turn";
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
      messages.push({ role: "user", content: renderToolResults(results) });
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
      systemPrompt,
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

/**
 * "The model ran out of room" has a different name on every provider:
 * `length` on OpenAI, `max_tokens` on Anthropic, `MAX_TOKENS` on Gemini.
 * They all mean the reply is truncated, which is a different outcome from a
 * finished turn and should not be traced as one.
 */
export function truncated(finishReason: string | undefined): boolean {
  if (!finishReason) return false;
  const reason = finishReason.toLowerCase();
  return reason === "length" || reason === "max_tokens";
}

function step(
  iteration: number,
  toolCalls: TraceStep["toolCalls"],
  response: Completion,
  startedAt: number,
): TraceStep {
  return {
    iteration,
    toolCalls,
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    latencyMs: Date.now() - startedAt,
  };
}
