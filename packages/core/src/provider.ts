import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { Provider } from "./types.js";

const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

/**
 * The only place a provider is named. Everything above this file works against
 * LangChain's chat-model interface, so swapping providers is config, not code.
 * Providers are imported lazily — a run that only talks to OpenRouter never
 * loads the Anthropic or Gemini clients.
 */
export async function chatModel(
  provider: Provider,
  model: string,
  maxTokens: number,
): Promise<BaseChatModel> {
  switch (provider) {
    // OpenRouter speaks the OpenAI wire format, so it is the OpenAI client
    // pointed at a different base URL. Model ids are namespaced by vendor,
    // e.g. "z-ai/glm-5.3-flash".
    case "openrouter": {
      const { ChatOpenAI } = await import("@langchain/openai");
      return new ChatOpenAI({
        model,
        maxTokens,
        apiKey: process.env.OPENROUTER_API_KEY,
        // Reasoning models stay silent unless asked; this is what makes
        // thinking_delta events show up on the stream. Harmless on models
        // that do not reason — OpenRouter ignores it.
        //
        // __includeRawResponse is needed with it: OpenRouter returns reasoning
        // on `delta.reasoning`, which LangChain drops from the parsed chunk.
        ...(process.env.AGENT_REASONING === "false"
          ? {}
          : {
              modelKwargs: { reasoning: { enabled: true } },
              __includeRawResponse: true,
            }),
        configuration: {
          baseURL: OPENROUTER_BASE_URL,
          defaultHeaders: {
            // Optional attribution headers; OpenRouter shows these on the
            // activity page and in rankings.
            "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "",
            "X-Title": process.env.OPENROUTER_APP_NAME ?? "mini-agent",
          },
        },
      });
    }
    case "openai": {
      const { ChatOpenAI } = await import("@langchain/openai");
      return new ChatOpenAI({ model, maxTokens });
    }
    case "anthropic": {
      const { ChatAnthropic } = await import("@langchain/anthropic");
      return new ChatAnthropic({ model, maxTokens });
    }
    case "google": {
      const { ChatGoogleGenerativeAI } = await import("@langchain/google-genai");
      return new ChatGoogleGenerativeAI({ model, maxOutputTokens: maxTokens });
    }
  }
}
