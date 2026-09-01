import { getConfig } from "@mini-agent/config";
import type OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import {
  collectStream,
  reasoningEnabled,
  type ChatClient,
  type ChatOptions,
  type Delta,
  type Msg,
  type Provider,
  type Usage,
} from "./types.js";

/** Roles map one-to-one; the OpenAI wire format is the one that needs no translation. */
export function toOpenAIMessages(messages: Msg[]): ChatCompletionMessageParam[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

/**
 * Reasoning tokens have no standard field. OpenRouter sends `delta.reasoning`,
 * other OpenAI-compatible hosts send `delta.reasoning_content`. Neither is in
 * the SDK's types, so read them off the raw chunk.
 */
export function reasoningOf(chunk: ChatCompletionChunk): string {
  const delta = chunk.choices[0]?.delta as
    | { reasoning?: unknown; reasoning_content?: unknown }
    | undefined;
  const value = delta?.reasoning ?? delta?.reasoning_content;
  return typeof value === "string" ? value : "";
}

/**
 * Covers `openrouter` and `openai` both — OpenRouter is the OpenAI client
 * pointed at a different base URL, with model ids namespaced by vendor
 * (e.g. "z-ai/glm-5.3-flash").
 */
export class OpenAICompatClient implements ChatClient {
  readonly provider: Provider;
  readonly model: string;
  private readonly maxTokens: number;
  private client?: OpenAI;

  constructor(provider: "openrouter" | "openai", options: ChatOptions) {
    this.provider = provider;
    this.model = options.model;
    this.maxTokens = options.maxTokens;
  }

  /** Lazy so a run that never touches this provider never constructs a client. */
  private async sdk(): Promise<OpenAI> {
    if (!this.client) {
      const { default: OpenAIClient } = await import("openai");
      const { openrouter, openai } = getConfig().llm;
      this.client =
        this.provider === "openrouter"
          ? new OpenAIClient({
              apiKey: openrouter.apiKey,
              baseURL: openrouter.baseUrl,
              defaultHeaders: {
                // Optional attribution; OpenRouter shows these on the activity
                // page and in rankings.
                "HTTP-Referer": openrouter.siteUrl,
                "X-Title": openrouter.appName,
              },
            })
          : new OpenAIClient({ apiKey: openai.apiKey });
    }
    return this.client;
  }

  private body(messages: Msg[]): Record<string, unknown> {
    return {
      model: this.model,
      messages: toOpenAIMessages(messages),
      // OpenRouter normalises `max_tokens`; OpenAI's reasoning models reject it
      // and require `max_completion_tokens`.
      ...(this.provider === "openrouter"
        ? { max_tokens: this.maxTokens }
        : { max_completion_tokens: this.maxTokens }),
      // Reasoning models stay silent unless asked. Harmless on models that do
      // not reason — OpenRouter ignores it.
      ...(this.provider === "openrouter" && reasoningEnabled()
        ? { reasoning: { enabled: true } }
        : {}),
    };
  }

  async invoke(messages: Msg[]) {
    const client = await this.sdk();
    // `body` carries non-standard fields (OpenRouter's `reasoning`), so the
    // params are assembled loosely and narrowed here.
    const response = (await client.chat.completions.create({
      ...this.body(messages),
      stream: false,
    } as unknown as ChatCompletionCreateParams)) as ChatCompletion;

    const choice = response.choices[0];
    const message = choice?.message as
      | { content?: string | null; reasoning?: unknown; reasoning_content?: unknown }
      | undefined;
    const reasoning = message?.reasoning ?? message?.reasoning_content;

    return {
      text: message?.content ?? "",
      thinking: typeof reasoning === "string" ? reasoning : "",
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
      finishReason: choice?.finish_reason ?? undefined,
    };
  }

  async *stream(messages: Msg[]): AsyncGenerator<Delta, void, undefined> {
    const client = await this.sdk();
    const stream = (await client.chat.completions.create({
      ...this.body(messages),
      stream: true,
      // Without this the final usage chunk never arrives and the token
      // guardrail has nothing to count.
      stream_options: { include_usage: true },
    } as unknown as ChatCompletionCreateParams)) as unknown as AsyncIterable<ChatCompletionChunk>;

    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let finish: string | undefined;

    for await (const chunk of stream) {
      const thinking = reasoningOf(chunk);
      if (thinking) yield { type: "thinking", text: thinking };

      const text = chunk.choices[0]?.delta?.content;
      if (text) yield { type: "text", text };

      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
        };
      }
      finish = chunk.choices[0]?.finish_reason ?? finish;
    }

    yield { type: "usage", usage };
    if (finish) yield { type: "finish", reason: finish };
  }
}

/** Exported for `invoke`'s benefit in tests and for adapters that reuse the fold. */
export { collectStream };
