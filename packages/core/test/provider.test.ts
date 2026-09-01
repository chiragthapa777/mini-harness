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

/** Forces the lazily constructed SDK so its configuration can be inspected. */
async function sdkOf(client: unknown): Promise<{ baseURL?: string }> {
  return (await (client as { sdk(): Promise<{ baseURL?: string }> }).sdk()) ?? {};
}

test("builds a chat client for every supported provider", () => {
  for (const provider of ["openrouter", "openai", "anthropic", "google"] as const) {
    const model = chatModel(provider, "test-model", 512);
    assert.equal(typeof model.invoke, "function", `${provider} has no invoke`);
    assert.equal(typeof model.stream, "function", `${provider} has no stream`);
    assert.equal(model.provider, provider);
  }
});

test("the model id is passed through untouched", () => {
  assert.equal(chatModel("openrouter", "z-ai/glm-5.3-flash", 512).model, "z-ai/glm-5.3-flash");
});

test("openrouter points the openai client at openrouter, not openai", async () => {
  const client = chatModel("openrouter", "z-ai/glm-5.3-flash", 512);
  const sdk = await sdkOf(client);

  assert.equal(sdk.baseURL, "https://openrouter.ai/api/v1");

  const headers = (sdk as { _options?: { defaultHeaders?: Record<string, string> } })._options
    ?.defaultHeaders;
  assert.equal(headers?.["X-Title"], "mini-agent");
});

test("plain openai keeps the default base url", async () => {
  const sdk = await sdkOf(chatModel("openai", "gpt-4.1", 512));
  assert.match(String(sdk.baseURL), /api\.openai\.com/);
});

test("no SDK is constructed until the client is used", () => {
  const client = chatModel("anthropic", "claude-opus-5", 512) as unknown as {
    client?: unknown;
  };
  assert.equal(client.client, undefined);
});
