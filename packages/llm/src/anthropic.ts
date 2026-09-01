import { getConfig } from "@mini-agent/config";
import type Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, MessageStreamEvent } from "@anthropic-ai/sdk/resources/messages";
import {
  collectStream,
  type ChatClient,
  type ChatOptions,
  type Delta,
  type Msg,
  type Provider,
  type Usage,
} from "./types.js";

export interface AnthropicParams {
  system: string;
  messages: MessageParam[];
}

/**
 * Anthropic differs from the OpenAI format in three ways that matter here:
 * the system prompt is a top-level parameter rather than a message, adjacent
 * messages may not share a role, and the first message must be from the user.
 *
 * Leading assistant messages are dropped rather than reshaped — that only
 * happens if episodic recall returns a window starting mid-reply, where the
 * orphaned turn carries no question for the model to answer anyway.
 */
export function toAnthropicParams(messages: Msg[]): AnthropicParams {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");

  const turns: MessageParam[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    const previous = turns.at(-1);
    if (previous && previous.role === message.role) {
      previous.content = `${previous.content as string}\n\n${message.content}`;
      continue;
    }
    if (!previous && message.role === "assistant") continue;
    turns.push({ role: message.role, content: message.content });
  }

  return { system, messages: turns };
}

export class AnthropicClient implements ChatClient {
  readonly provider: Provider = "anthropic";
  readonly model: string;
  private readonly maxTokens: number;
  private client?: Anthropic;

  constructor(options: ChatOptions) {
    this.model = options.model;
    this.maxTokens = options.maxTokens;
  }

  private async sdk(): Promise<Anthropic> {
    if (!this.client) {
      const { default: AnthropicClientCtor } = await import("@anthropic-ai/sdk");
      this.client = new AnthropicClientCtor({ apiKey: getConfig().llm.anthropic.apiKey });
    }
    return this.client;
  }

  /**
   * Extended thinking is not requested. It needs a per-model budget and forces
   * temperature to 1, and enabling it on a model that does not support it is an
   * error — so it stays a deliberate choice, not a default. `thinking_delta`
   * events are still surfaced if a model emits them.
   */
  private body(messages: Msg[]) {
    const { system, messages: turns } = toAnthropicParams(messages);
    return {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: turns,
      ...(system ? { system } : {}),
    };
  }

  async invoke(messages: Msg[]) {
    const client = await this.sdk();
    const response = await client.messages.create({ ...this.body(messages), stream: false });

    let text = "";
    let thinking = "";
    for (const block of response.content) {
      if (block.type === "text") text += block.text;
      else if (block.type === "thinking") thinking += block.thinking;
    }

    return {
      text,
      thinking,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      finishReason: response.stop_reason ?? undefined,
    };
  }

  async *stream(messages: Msg[]): AsyncGenerator<Delta, void, undefined> {
    const client = await this.sdk();
    const stream = await client.messages.create({ ...this.body(messages), stream: true });

    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let finish: string | undefined;

    for await (const event of stream as AsyncIterable<MessageStreamEvent>) {
      if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta" && event.delta.text) {
          yield { type: "text", text: event.delta.text };
        } else if (event.delta.type === "thinking_delta" && event.delta.thinking) {
          yield { type: "thinking", text: event.delta.thinking };
        }
      } else if (event.type === "message_start") {
        // Input tokens are only ever reported here; output tokens arrive as a
        // running total on message_delta.
        usage = {
          inputTokens: event.message.usage.input_tokens,
          outputTokens: event.message.usage.output_tokens,
        };
      } else if (event.type === "message_delta") {
        usage = { ...usage, outputTokens: event.usage.output_tokens };
        finish = event.delta.stop_reason ?? finish;
      }
    }

    yield { type: "usage", usage };
    if (finish) yield { type: "finish", reason: finish };
  }
}

export { collectStream };
