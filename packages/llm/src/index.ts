import { AnthropicClient } from "./anthropic.js";
import { GoogleClient } from "./google.js";
import { OpenAICompatClient } from "./openai-compat.js";
import type { ChatClient, Connection, Provider } from "./types.js";

export type {
  CallOptions,
  ChatClient,
  ChatOptions,
  Completion,
  Connection,
  Delta,
  Msg,
  Provider,
  Role,
  Usage,
} from "./types.js";
export { cancelled, collectStream, reasoningEnabled } from "./types.js";

export { OpenAICompatClient, toOpenAIMessages, reasoningOf } from "./openai-compat.js";
export { AnthropicClient, toAnthropicParams, type AnthropicParams } from "./anthropic.js";
export { GoogleClient, toGoogleParams, type GoogleParams } from "./google.js";
export {
  embed,
  embedQuery,
  embeddingsConfigured,
  EMBEDDING_DIMENSIONS,
} from "./embeddings.js";

/**
 * The only place a provider is named. Everything above this package works
 * against `ChatClient`, so swapping providers is config, not code. SDKs are
 * imported lazily inside each client — a run that only talks to OpenRouter
 * never loads the Anthropic or Gemini SDK.
 *
 * `connection` is optional: the server leaves it out and gets keys from
 * `@mini-agent/config`; a client with its own settings passes them in.
 */
export function chatModel(
  provider: Provider,
  model: string,
  maxTokens: number,
  connection: Connection = {},
): ChatClient {
  const options = { model, maxTokens, ...connection };
  switch (provider) {
    case "openrouter":
    case "openai":
      return new OpenAICompatClient(provider, options);
    case "anthropic":
      return new AnthropicClient(options);
    case "google":
      return new GoogleClient(options);
  }
}
