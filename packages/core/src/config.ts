import type { Provider, RunConfig } from "./types.js";

/**
 * Prompts, model choice, and guardrails are config — versioned and released,
 * not inlined at call sites. PROMPT_VERSION is what the ops release step bumps.
 */
export const SYSTEM_PROMPT = [
  "You are a personal AI agent.",
  "Use the tools available to you rather than guessing.",
  "Answer directly and concisely.",
].join(" ");

export const PROMPT_VERSION = process.env.PROMPT_VERSION ?? "1";

export function runConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    provider: (process.env.AGENT_PROVIDER as Provider) ?? "openrouter",
    model: process.env.AGENT_MODEL ?? "z-ai/glm-5.3-flash",
    maxTokens: num(process.env.AGENT_MAX_TOKENS, 16000),
    guardrails: {
      maxIterations: num(process.env.AGENT_MAX_ITERATIONS, 8),
      maxTokensPerRun: num(process.env.AGENT_MAX_TOKENS_PER_RUN, 100_000),
    },
    ...overrides,
  };
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
