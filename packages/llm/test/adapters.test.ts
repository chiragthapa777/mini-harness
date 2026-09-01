import assert from "node:assert/strict";
import { test } from "node:test";
import { AnthropicClient } from "../src/anthropic.js";
import { GoogleClient } from "../src/google.js";
import { OpenAICompatClient } from "../src/openai-compat.js";
import type { ChatClient, Delta, Msg } from "../src/types.js";

const messages: Msg[] = [
  { role: "system", content: "You are a test agent." },
  { role: "user", content: "hello" },
];

/** Replaces the lazily constructed SDK so no adapter test touches the network. */
function stub(client: ChatClient, sdk: unknown): void {
  (client as unknown as { client: unknown }).client = sdk;
}

async function* iterate<T>(items: T[]): AsyncGenerator<T, void, undefined> {
  for (const item of items) yield item;
}

async function collect(stream: AsyncGenerator<Delta, void, undefined>): Promise<Delta[]> {
  const deltas: Delta[] = [];
  for await (const delta of stream) deltas.push(delta);
  return deltas;
}

const texts = (deltas: Delta[]) =>
  deltas.filter((d) => d.type === "text").map((d) => d.text).join("");
const thinking = (deltas: Delta[]) =>
  deltas.filter((d) => d.type === "thinking").map((d) => d.text).join("");

/** The contract every adapter owes the loop, checked identically for all three. */
function assertStreamContract(deltas: Delta[]): void {
  const usage = deltas.filter((d) => d.type === "usage");
  assert.equal(usage.length, 1, "exactly one usage delta per stream");

  const finishIndex = deltas.findIndex((d) => d.type === "finish");
  const usageIndex = deltas.indexOf(usage[0]!);
  assert.ok(finishIndex > usageIndex, "usage is emitted before finish");
  assert.equal(finishIndex, deltas.length - 1, "finish is last");
}

// --- OpenAI-compatible -----------------------------------------------------

test("openai-compat streams text, reasoning, usage and finish", async () => {
  const client = new OpenAICompatClient("openrouter", { model: "z-ai/glm-5.3-flash", maxTokens: 1024 });
  let body: Record<string, unknown> = {};

  stub(client, {
    chat: {
      completions: {
        create: async (request: Record<string, unknown>) => {
          body = request;
          return iterate([
            { choices: [{ delta: { reasoning: "let me reason" } }] },
            { choices: [{ delta: { content: "Hello" } }] },
            { choices: [{ delta: { content: " there." }, finish_reason: "stop" }] },
            { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } },
          ]);
        },
      },
    },
  });

  const deltas = await collect(client.stream(messages));

  assert.equal(texts(deltas), "Hello there.");
  assert.equal(thinking(deltas), "let me reason");
  assertStreamContract(deltas);
  assert.deepEqual(
    deltas.find((d) => d.type === "usage"),
    { type: "usage", usage: { inputTokens: 10, outputTokens: 4 } },
  );

  assert.equal(body["stream"], true);
  assert.deepEqual(body["stream_options"], { include_usage: true });
  assert.equal(body["max_tokens"], 1024);
  assert.deepEqual(body["reasoning"], { enabled: true });
});

test("openai provider uses max_completion_tokens and sends no reasoning flag", async () => {
  const client = new OpenAICompatClient("openai", { model: "gpt-5", maxTokens: 512 });
  let body: Record<string, unknown> = {};

  stub(client, {
    chat: {
      completions: {
        create: async (request: Record<string, unknown>) => {
          body = request;
          return iterate([{ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }]);
        },
      },
    },
  });

  await collect(client.stream(messages));

  assert.equal(body["max_completion_tokens"], 512);
  assert.equal(body["max_tokens"], undefined);
  assert.equal(body["reasoning"], undefined);
});

test("openai-compat invoke returns text, usage and finish reason", async () => {
  const client = new OpenAICompatClient("openrouter", { model: "m", maxTokens: 128 });

  stub(client, {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: "an answer", reasoning: "hmm" }, finish_reason: "length" }],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        }),
      },
    },
  });

  assert.deepEqual(await client.invoke(messages), {
    text: "an answer",
    thinking: "hmm",
    usage: { inputTokens: 7, outputTokens: 3 },
    finishReason: "length",
  });
});

// --- Anthropic -------------------------------------------------------------

test("anthropic streams text and thinking, and totals usage across events", async () => {
  const client = new AnthropicClient({ model: "claude-opus-5", maxTokens: 2048 });
  let body: Record<string, unknown> = {};

  stub(client, {
    messages: {
      create: async (request: Record<string, unknown>) => {
        body = request;
        return iterate([
          { type: "message_start", message: { usage: { input_tokens: 12, output_tokens: 0 } } },
          { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "reasoning" } },
          { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
          { type: "content_block_delta", delta: { type: "text_delta", text: " there." } },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
        ]);
      },
    },
  });

  const deltas = await collect(client.stream(messages));

  assert.equal(texts(deltas), "Hello there.");
  assert.equal(thinking(deltas), "reasoning");
  assertStreamContract(deltas);
  assert.deepEqual(
    deltas.find((d) => d.type === "usage"),
    { type: "usage", usage: { inputTokens: 12, outputTokens: 5 } },
  );

  // The system prompt must not survive as a message.
  assert.equal(body["system"], "You are a test agent.");
  assert.deepEqual(body["messages"], [{ role: "user", content: "hello" }]);
  assert.equal(body["max_tokens"], 2048);
});

test("anthropic invoke splits text and thinking content blocks", async () => {
  const client = new AnthropicClient({ model: "claude-opus-5", maxTokens: 256 });

  stub(client, {
    messages: {
      create: async () => ({
        content: [
          { type: "thinking", thinking: "considering" },
          { type: "text", text: "the answer" },
        ],
        usage: { input_tokens: 9, output_tokens: 2 },
        stop_reason: "end_turn",
      }),
    },
  });

  assert.deepEqual(await client.invoke(messages), {
    text: "the answer",
    thinking: "considering",
    usage: { inputTokens: 9, outputTokens: 2 },
    finishReason: "end_turn",
  });
});

// --- Google ----------------------------------------------------------------

test("google streams text, separates thought parts, and takes the last usage", async () => {
  const client = new GoogleClient({ model: "gemini-2.5-pro", maxTokens: 4096 });
  let request: Record<string, unknown> = {};

  const chunk = (parts: unknown[], extra: Record<string, unknown> = {}) => ({
    candidates: [{ content: { parts }, ...(extra["finishReason"] ? { finishReason: extra["finishReason"] } : {}) }],
    ...(extra["usageMetadata"] ? { usageMetadata: extra["usageMetadata"] } : {}),
  });

  stub(client, {
    models: {
      generateContentStream: async (req: Record<string, unknown>) => {
        request = req;
        return iterate([
          chunk([{ text: "reasoning", thought: true }]),
          chunk([{ text: "Hello" }], {
            usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 1 },
          }),
          chunk([{ text: " there." }], {
            finishReason: "STOP",
            // Cumulative, and thought tokens are counted separately.
            usageMetadata: {
              promptTokenCount: 11,
              candidatesTokenCount: 3,
              thoughtsTokenCount: 6,
            },
          }),
        ]);
      },
    },
  });

  const deltas = await collect(client.stream(messages));

  assert.equal(texts(deltas), "Hello there.");
  assert.equal(thinking(deltas), "reasoning");
  assertStreamContract(deltas);
  assert.deepEqual(
    deltas.find((d) => d.type === "usage"),
    { type: "usage", usage: { inputTokens: 11, outputTokens: 9 } },
  );

  const config = request["config"] as Record<string, unknown>;
  assert.equal(config["systemInstruction"], "You are a test agent.");
  assert.equal(config["maxOutputTokens"], 4096);
  assert.deepEqual(request["contents"], [{ role: "user", parts: [{ text: "hello" }] }]);
});

test("google invoke returns text without thought parts", async () => {
  const client = new GoogleClient({ model: "gemini-2.5-pro", maxTokens: 256 });

  stub(client, {
    models: {
      generateContent: async () => ({
        candidates: [
          {
            content: { parts: [{ text: "hidden", thought: true }, { text: "shown" }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, thoughtsTokenCount: 1 },
      }),
    },
  });

  assert.deepEqual(await client.invoke(messages), {
    text: "shown",
    thinking: "hidden",
    usage: { inputTokens: 4, outputTokens: 3 },
    finishReason: "STOP",
  });
});
