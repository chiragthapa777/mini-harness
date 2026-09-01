import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { getConfig } from "../src/index.js";

const keys = [
  "AGENT_PROVIDER",
  "AGENT_MODEL",
  "AGENT_MAX_TOKENS",
  "AGENT_MAX_ITERATIONS",
  "AGENT_MAX_TOKENS_PER_RUN",
  "AGENT_REASONING",
  "SEARCH_SAFE_SEARCH",
  "RAG_TOP_K",
  "DATABASE_URL",
];

afterEach(() => {
  for (const key of keys) delete process.env[key];
});

test("defaults match the documented values", () => {
  const config = getConfig();
  assert.equal(config.agent.provider, "openrouter");
  assert.equal(config.agent.model, "z-ai/glm-5.3-flash");
  assert.equal(config.agent.maxTokens, 16000);
  assert.equal(config.agent.maxIterations, 8);
  assert.equal(config.agent.maxTokensPerRun, 100_000);
  assert.equal(config.llm.reasoningEnabled, true);
  assert.equal(config.search.safeSearch, "moderate");
  assert.equal(config.memory.ragTopK, 5);
  assert.equal(config.db.url, undefined);
});

test("env overrides are picked up on every call, not cached", () => {
  assert.equal(getConfig().agent.provider, "openrouter");
  process.env["AGENT_PROVIDER"] = "anthropic";
  assert.equal(getConfig().agent.provider, "anthropic");
});

test("invalid enum values fall back instead of throwing", () => {
  process.env["SEARCH_SAFE_SEARCH"] = "nonsense";
  assert.equal(getConfig().search.safeSearch, "moderate");
});

test("garbage or non-positive numbers fall back instead of producing NaN", () => {
  process.env["AGENT_MAX_TOKENS"] = "not-a-number";
  process.env["AGENT_MAX_ITERATIONS"] = "0";
  const config = getConfig();
  assert.equal(config.agent.maxTokens, 16000);
  assert.equal(config.agent.maxIterations, 8);
});

test("AGENT_REASONING is opt-out: only the literal string \"false\" disables it", () => {
  process.env["AGENT_REASONING"] = "false";
  assert.equal(getConfig().llm.reasoningEnabled, false);
  process.env["AGENT_REASONING"] = "anything-else";
  assert.equal(getConfig().llm.reasoningEnabled, true);
});

test("DATABASE_URL is passed through untouched when set", () => {
  process.env["DATABASE_URL"] = "postgres://localhost:5432/test";
  assert.equal(getConfig().db.url, "postgres://localhost:5432/test");
});
