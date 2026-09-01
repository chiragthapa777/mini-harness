import { getConfig } from "@mini-agent/config";
import type { GoogleGenAI } from "@google/genai";
import type { Content, GenerateContentResponse } from "@google/genai";
import {
  collectStream,
  type ChatClient,
  type ChatOptions,
  type Delta,
  type Msg,
  type Provider,
  type Usage,
} from "./types.js";

export interface GoogleParams {
  systemInstruction: string;
  contents: Content[];
}

/**
 * Gemini calls the assistant "model", takes the system prompt as a separate
 * `systemInstruction`, and wraps text in `parts`. Adjacent same-role turns are
 * merged for the same reason as Anthropic — the API is happiest with strict
 * alternation.
 */
export function toGoogleParams(messages: Msg[]): GoogleParams {
  const systemInstruction = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");

  const contents: Content[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    const role = message.role === "assistant" ? "model" : "user";
    const previous = contents.at(-1);
    if (previous && previous.role === role) {
      previous.parts?.push({ text: message.content });
      continue;
    }
    contents.push({ role, parts: [{ text: message.content }] });
  }

  return { systemInstruction, contents };
}

/** Gemini reports thinking as ordinary text parts flagged with `thought`. */
function split(response: GenerateContentResponse): { text: string; thinking: string } {
  let text = "";
  let thinking = "";
  for (const part of response.candidates?.[0]?.content?.parts ?? []) {
    if (!part.text) continue;
    if (part.thought) thinking += part.text;
    else text += part.text;
  }
  return { text, thinking };
}

/** Thought tokens are billed as output but counted separately from candidates. */
function usageOf(response: GenerateContentResponse): Usage | undefined {
  const meta = response.usageMetadata;
  if (!meta) return undefined;
  return {
    inputTokens: meta.promptTokenCount ?? 0,
    outputTokens: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0),
  };
}

export class GoogleClient implements ChatClient {
  readonly provider: Provider = "google";
  readonly model: string;
  private readonly maxTokens: number;
  private client?: GoogleGenAI;

  constructor(options: ChatOptions) {
    this.model = options.model;
    this.maxTokens = options.maxTokens;
  }

  private async sdk(): Promise<GoogleGenAI> {
    if (!this.client) {
      const { GoogleGenAI: Ctor } = await import("@google/genai");
      this.client = new Ctor({ apiKey: getConfig().llm.google.apiKey });
    }
    return this.client;
  }

  /**
   * `includeThoughts` is left off for parity with the other adapters: thinking
   * is surfaced when a model volunteers it, not requested by default.
   */
  private request(messages: Msg[]) {
    const { systemInstruction, contents } = toGoogleParams(messages);
    return {
      model: this.model,
      contents,
      config: {
        maxOutputTokens: this.maxTokens,
        ...(systemInstruction ? { systemInstruction } : {}),
      },
    };
  }

  async invoke(messages: Msg[]) {
    const client = await this.sdk();
    const response = await client.models.generateContent(this.request(messages));
    const { text, thinking } = split(response);

    return {
      text,
      thinking,
      usage: usageOf(response) ?? { inputTokens: 0, outputTokens: 0 },
      finishReason: response.candidates?.[0]?.finishReason ?? undefined,
    };
  }

  async *stream(messages: Msg[]): AsyncGenerator<Delta, void, undefined> {
    const client = await this.sdk();
    const stream = await client.models.generateContentStream(this.request(messages));

    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let finish: string | undefined;

    for await (const chunk of stream) {
      const { text, thinking } = split(chunk);
      if (thinking) yield { type: "thinking", text: thinking };
      if (text) yield { type: "text", text };

      // Gemini reports cumulative totals on every chunk, so take the last.
      usage = usageOf(chunk) ?? usage;
      finish = chunk.candidates?.[0]?.finishReason ?? finish;
    }

    yield { type: "usage", usage };
    if (finish) yield { type: "finish", reason: finish };
  }
}

export { collectStream };
