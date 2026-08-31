import type { BaseMessage } from "@langchain/core/messages";
import type { z } from "zod";

/**
 * LangChain is used for one thing only: talking to whichever provider.
 * `openrouter` is the OpenAI-compatible endpoint — same wire format, different
 * base URL and key, and every model OpenRouter fronts (GLM, Claude, GPT, …).
 */
export type Provider = "openrouter" | "anthropic" | "openai" | "google";

/** A tool the agent can call. The handler runs in the harness, not the model. */
export interface AgentTool<S extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> {
  name: string;
  description: string;
  schema: S;
  run(input: z.infer<S>): Promise<string>;
}

/** Everything assembled into working memory for one run. */
export interface WorkingMemory {
  systemPrompt: string;
  procedural: string[];
  semantic: string[];
  episodic: string[];
  history: BaseMessage[];
  userPrompt: string;
}

/** End-loop guardrails. A loop without these can spin forever. */
export interface Guardrails {
  maxIterations: number;
  maxTokensPerRun: number;
}

export interface RunConfig {
  provider: Provider;
  model: string;
  maxTokens: number;
  guardrails: Guardrails;
}

export type StopReason =
  | "end_turn"
  | "max_iterations"
  | "token_budget"
  | "length"
  | "error";

export interface TraceStep {
  iteration: number;
  toolCalls: { name: string; input: unknown; isError: boolean }[];
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

/** One trace per run — the unit of analysis for LLM Ops. */
export interface Trace {
  provider: Provider;
  model: string;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  stopReason: StopReason;
  error?: string;
  steps: TraceStep[];
}

export interface RunResult {
  reply: string;
  trace: Trace;
}

/**
 * Everything the harness does, as it happens. `runAgentStream` yields these in
 * order; the SSE endpoint forwards them to the browser unchanged.
 */
export type RunEvent =
  | { type: "run_start"; provider: Provider; model: string }
  | { type: "iteration_start"; iteration: number }
  | { type: "thinking_delta"; text: string }
  | { type: "text_delta"; text: string }
  | { type: "iteration_end"; iteration: number; inputTokens: number; outputTokens: number }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; output: string; isError: boolean }
  | { type: "guardrail"; reason: StopReason }
  | { type: "reply"; text: string }
  | { type: "trace"; trace: Trace }
  | { type: "error"; message: string };
