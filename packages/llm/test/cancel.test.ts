import assert from "node:assert/strict";
import { test } from "node:test";
import { chatModel } from "../src/index.js";
import { AnthropicClient } from "../src/anthropic.js";
import { GoogleClient } from "../src/google.js";
import { OpenAICompatClient } from "../src/openai-compat.js";
import type { ChatClient, Delta, Msg } from "../src/types.js";

const messages: Msg[] = [{ role: "user", content: "hello" }];

/** Replaces the lazily constructed SDK so no test touches the network. */
function stub(client: ChatClient, sdk: unknown): void {
  (client as unknown as { client: unknown }).client = sdk;
}

/** The SDK's own construction path, so the connection it was built with can be read back. */
async function sdkOf(client: ChatClient): Promise<unknown> {
  return (client as unknown as { sdk(): Promise<unknown> }).sdk();
}

async function* iterate<T>(items: T[]): AsyncGenerator<T, void, undefined> {
  for (const item of items) yield item;
}

/** Each adapter's stream fixture: two text chunks, with SDK-specific shapes. */
const streams: { name: string; make(): ChatClient; sdk(chunks: string[]): unknown }[] = [
  {
    name: "openai-compat",
    make: () => new OpenAICompatClient("openrouter", { model: "m", maxTokens: 64 }),
    sdk: (chunks) => ({
      chat: {
        completions: {
          create: async () => iterate(chunks.map((content) => ({ choices: [{ delta: { content } }] }))),
        },
      },
    }),
  },
  {
    name: "anthropic",
    make: () => new AnthropicClient({ model: "m", maxTokens: 64 }),
    sdk: (chunks) => ({
      messages: {
        create: async () =>
          iterate(
            chunks.map((text) => ({ type: "content_block_delta", delta: { type: "text_delta", text } })),
          ),
      },
    }),
  },
  {
    name: "google",
    make: () => new GoogleClient({ model: "m", maxTokens: 64 }),
    sdk: (chunks) => ({
      models: {
        generateContentStream: async () =>
          iterate(chunks.map((text) => ({ candidates: [{ content: { parts: [{ text }] } }] }))),
      },
    }),
  },
];

for (const fixture of streams) {
  test(`${fixture.name}: aborting mid-stream stops deltas and throws the signal's reason`, async () => {
    const client = fixture.make();
    stub(client, fixture.sdk(["first", "second"]));

    const controller = new AbortController();
    const reason = new Error("user pressed Esc");
    const seen: Delta[] = [];

    await assert.rejects(
      (async () => {
        for await (const delta of client.stream(messages, { signal: controller.signal })) {
          seen.push(delta);
          controller.abort(reason);
        }
      })(),
      (err) => err === reason,
    );

    // The chunk already in flight is the last one: no second text, no usage.
    assert.deepEqual(seen, [{ type: "text", text: "first" }]);
  });

  test(`${fixture.name}: a stream already cancelled yields nothing`, async () => {
    const client = fixture.make();
    stub(client, fixture.sdk(["first"]));

    const controller = new AbortController();
    controller.abort();
    const seen: Delta[] = [];

    await assert.rejects(async () => {
      for await (const delta of client.stream(messages, { signal: controller.signal })) {
        seen.push(delta);
      }
    }, { name: "AbortError" });
    assert.deepEqual(seen, []);
  });
}

test("the signal reaches each SDK the way that SDK expects it", async () => {
  const { signal } = new AbortController();

  const openai = new OpenAICompatClient("openrouter", { model: "m", maxTokens: 64 });
  let openaiOptions: unknown;
  stub(openai, {
    chat: {
      completions: {
        create: async (_body: unknown, options: unknown) => {
          openaiOptions = options;
          return { choices: [{ message: { content: "ok" } }] };
        },
      },
    },
  });
  await openai.invoke(messages, { signal });
  assert.equal((openaiOptions as { signal?: AbortSignal }).signal, signal);

  const anthropic = new AnthropicClient({ model: "m", maxTokens: 64 });
  let anthropicOptions: unknown;
  stub(anthropic, {
    messages: {
      create: async (_body: unknown, options: unknown) => {
        anthropicOptions = options;
        return { content: [], usage: { input_tokens: 0, output_tokens: 0 } };
      },
    },
  });
  await anthropic.invoke(messages, { signal });
  assert.equal((anthropicOptions as { signal?: AbortSignal }).signal, signal);

  // Gemini takes it as request config rather than a second argument.
  const google = new GoogleClient({ model: "m", maxTokens: 64 });
  let googleRequest: { config?: { abortSignal?: AbortSignal } } = {};
  stub(google, {
    models: {
      generateContent: async (request: typeof googleRequest) => {
        googleRequest = request;
        return { candidates: [] };
      },
    },
  });
  await google.invoke(messages, { signal });
  assert.equal(googleRequest.config?.abortSignal, signal);
});

test("invoke rethrows the SDK's own abort error as the signal's reason", async () => {
  const client = new OpenAICompatClient("openrouter", { model: "m", maxTokens: 64 });
  const controller = new AbortController();
  const reason = new Error("cancelled by caller");

  stub(client, {
    chat: {
      completions: {
        create: async () => {
          controller.abort(reason);
          // What the SDK does: its own error class, not the signal's reason.
          throw Object.assign(new Error("Request was aborted."), { name: "APIUserAbortError" });
        },
      },
    },
  });

  await assert.rejects(client.invoke(messages, { signal: controller.signal }), (err) => err === reason);
});

test("an error that is not a cancellation passes through untouched", async () => {
  const client = new AnthropicClient({ model: "m", maxTokens: 64 });
  const failure = new Error("529 overloaded");
  stub(client, {
    messages: {
      create: async () => {
        throw failure;
      },
    },
  });

  const { signal } = new AbortController();
  await assert.rejects(client.invoke(messages, { signal }), (err) => err === failure);
});

test("a connection passed to chatModel wins over the environment", async () => {
  const connection = { apiKey: "sk-from-settings", baseUrl: "https://llm.example.test/v1" };

  const openrouter = (await sdkOf(chatModel("openrouter", "m", 64, connection))) as {
    apiKey: string;
    baseURL: string;
  };
  assert.equal(openrouter.apiKey, connection.apiKey);
  assert.equal(openrouter.baseURL, connection.baseUrl);

  const anthropic = (await sdkOf(chatModel("anthropic", "m", 64, connection))) as {
    apiKey: string;
    baseURL: string;
  };
  assert.equal(anthropic.apiKey, connection.apiKey);
  assert.equal(anthropic.baseURL, connection.baseUrl);

  const google = (await sdkOf(chatModel("google", "m", 64, connection))) as {
    apiClient: { getApiKey(): string; getBaseUrl(): string };
  };
  assert.equal(google.apiClient.getApiKey(), connection.apiKey);
  assert.match(google.apiClient.getBaseUrl(), /^https:\/\/llm\.example\.test\/v1/);
});

test("without a connection, keys still come from the environment", async () => {
  const previous = process.env["OPENROUTER_API_KEY"];
  process.env["OPENROUTER_API_KEY"] = "sk-from-env";
  try {
    const client = (await sdkOf(chatModel("openrouter", "m", 64))) as {
      apiKey: string;
      baseURL: string;
    };
    assert.equal(client.apiKey, "sk-from-env");
    assert.equal(client.baseURL, "https://openrouter.ai/api/v1");
  } finally {
    if (previous === undefined) delete process.env["OPENROUTER_API_KEY"];
    else process.env["OPENROUTER_API_KEY"] = previous;
  }
});
