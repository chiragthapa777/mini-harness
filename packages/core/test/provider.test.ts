import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chatModel } from "../src/provider.js";

const stubbed = [
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
];
const saved = new Map<string, string | undefined>();

before(() => {
  for (const key of stubbed) {
    saved.set(key, process.env[key]);
    process.env[key] = process.env[key] ?? "test-key";
  }
});

after(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("builds a chat model for every supported provider", async () => {
  for (const provider of ["openrouter", "openai", "anthropic", "google"] as const) {
    const model = await chatModel(provider, "test-model", 512);
    assert.equal(typeof model.invoke, "function", `${provider} has no invoke`);
  }
});

test("the model id is passed through untouched", async () => {
  const model = (await chatModel("openrouter", "z-ai/glm-5.3-flash", 512)) as unknown as {
    model?: string;
    modelName?: string;
  };
  assert.equal(model.model ?? model.modelName, "z-ai/glm-5.3-flash");
});

test("openrouter points the openai client at openrouter, not openai", async () => {
  const model = (await chatModel("openrouter", "z-ai/glm-5.3-flash", 512)) as unknown as {
    clientConfig?: { baseURL?: string; defaultHeaders?: Record<string, string> };
  };

  assert.equal(model.clientConfig?.baseURL, "https://openrouter.ai/api/v1");
  assert.equal(model.clientConfig?.defaultHeaders?.["X-Title"], "mini-agent");
});

test("plain openai keeps the default base url", async () => {
  const model = (await chatModel("openai", "gpt-4.1", 512)) as unknown as {
    clientConfig?: { baseURL?: string };
  };

  assert.equal(model.clientConfig?.baseURL, undefined);
});
