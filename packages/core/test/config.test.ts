import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { runConfig } from "../src/config.js";

const keys = [
  "AGENT_PROVIDER",
  "AGENT_MODEL",
  "AGENT_MAX_TOKENS",
  "AGENT_MAX_ITERATIONS",
  "AGENT_MAX_TOKENS_PER_RUN",
];

afterEach(() => {
  for (const key of keys) delete process.env[key];
});

test("defaults to glm on openrouter with guardrails set", () => {
  const config = runConfig();
  assert.equal(config.provider, "openrouter");
  assert.equal(config.model, "z-ai/glm-5.3-flash");
  assert.equal(config.maxTokens, 16000);
  assert.equal(config.guardrails.maxIterations, 8);
  assert.equal(config.guardrails.maxTokensPerRun, 100_000);
});

test("env overrides provider, model, and guardrails", () => {
  process.env["AGENT_PROVIDER"] = "openai";
  process.env["AGENT_MODEL"] = "gpt-4.1";
  process.env["AGENT_MAX_ITERATIONS"] = "3";

  const config = runConfig();
  assert.equal(config.provider, "openai");
  assert.equal(config.model, "gpt-4.1");
  assert.equal(config.guardrails.maxIterations, 3);
});

test("garbage numbers fall back instead of producing NaN", () => {
  process.env["AGENT_MAX_TOKENS"] = "not-a-number";
  process.env["AGENT_MAX_ITERATIONS"] = "0";

  const config = runConfig();
  assert.equal(config.maxTokens, 16000);
  assert.equal(config.guardrails.maxIterations, 8);
});

test("explicit overrides win over env", () => {
  process.env["AGENT_MODEL"] = "from-env";
  assert.equal(runConfig({ model: "explicit" }).model, "explicit");
});
