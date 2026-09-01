import { getConfig } from "@mini-agent/config";
import type { RunConfig } from "./types.js";

/**
 * Prompts, model choice, and guardrails are config — versioned and released,
 * not inlined at call sites. PROMPT_VERSION is what the ops release step bumps.
 */
export const SYSTEM_PROMPT = [
  "You are a personal AI agent.",
  "Use the tools available to you rather than guessing.",
  "Answer directly and concisely.",
].join(" ");

export const PROMPT_VERSION = getConfig().agent.promptVersion;

export function runConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  const { agent } = getConfig();
  return {
    provider: agent.provider,
    model: agent.model,
    maxTokens: agent.maxTokens,
    guardrails: {
      maxIterations: agent.maxIterations,
      maxTokensPerRun: agent.maxTokensPerRun,
    },
    ...overrides,
  };
}
