import { AnthropicClient } from "./anthropic.js";
import { GoogleClient } from "./google.js";
import { OpenAICompatClient } from "./openai-compat.js";
import type { ChatClient, Provider } from "./types.js";

export type {
  ChatClient,
  ChatOptions,
  Completion,
  Delta,
  Msg,
  Provider,
  Role,
  Usage,
} from "./types.js";
export { collectStream, reasoningEnabled } from "./types.js";

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
 */
export function chatModel(provider: Provider, model: string, maxTokens: number): ChatClient {
  switch (provider) {
    case "openrouter":
    case "openai":
      return new OpenAICompatClient(provider, { model, maxTokens });
    case "anthropic":
      return new AnthropicClient({ model, maxTokens });
    case "google":
      return new GoogleClient({ model, maxTokens });
  }
}
