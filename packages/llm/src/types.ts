import { getConfig } from "@mini-agent/config";

/**
 * The chat transport, and nothing more.
 *
 * This package replaces what LangChain used to do here: give the harness one
 * chat interface across providers. It is deliberately two methods wide. The
 * loop, the tool-calling protocol, the guardrails, and the trace live in
 * `@mini-agent/core` and never see a provider.
 *
 * Content is always a plain string. Tool calls ride in a fenced ```tool_call
 * block parsed by the harness, so no provider-native tool schema, no content
 * block unions, and no per-provider message shapes leak past this boundary.
 */

/** `openrouter` is the OpenAI-compatible endpoint — same wire format, different base URL and key. */
export type Provider = "openrouter" | "anthropic" | "openai" | "google";

export type Role = "system" | "user" | "assistant";

export interface Msg {
  role: Role;
  content: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** One non-streaming turn. `thinking` is empty on models that do not reason. */
export interface Completion {
  text: string;
  thinking: string;
  usage: Usage;
  finishReason?: string;
}

/**
 * One streamed event. Providers disagree about when and how often they report
 * usage, so adapters accumulate internally and emit **exactly one** `usage`
 * delta per stream, carrying run totals, immediately before `finish`.
 */
export type Delta =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "usage"; usage: Usage }
  | { type: "finish"; reason: string };

/**
 * Per-call options. `signal` cancels the request: an aborted call rejects (or
 * the stream throws) with the signal's reason, and no further deltas arrive.
 */
export interface CallOptions {
  signal?: AbortSignal;
}

export interface ChatClient {
  readonly provider: Provider;
  readonly model: string;
  invoke(messages: Msg[], options?: CallOptions): Promise<Completion>;
  stream(messages: Msg[], options?: CallOptions): AsyncGenerator<Delta, void, undefined>;
}

/**
 * Where to reach the provider. Both fields are optional: anything left unset
 * falls back to `@mini-agent/config`, which is how the server runs. A caller
 * with its own settings (the mini-coder CLI) passes them here instead.
 */
export interface Connection {
  apiKey?: string;
  baseUrl?: string;
}

export interface ChatOptions extends Connection {
  model: string;
  maxTokens: number;
}

/** Shared by every adapter: reasoning is opt-out, matching the old provider.ts. */
export function reasoningEnabled(): boolean {
  return getConfig().llm.reasoningEnabled;
}

/**
 * Each SDK fails a cancelled request with its own error class. Callers should
 * not have to know which, so once the signal has fired every adapter rethrows
 * the signal's reason instead — one shape, whatever the provider.
 */
export function cancelled(err: unknown, signal: AbortSignal | undefined): unknown {
  return signal?.aborted ? signal.reason : err;
}

/**
 * Folds a `Completion` out of a stream, so an adapter only has to implement
 * `stream` well and gets `invoke` for free when the provider has no cheaper
 * non-streaming path worth keeping separate.
 */
export async function collectStream(
  stream: AsyncGenerator<Delta, void, undefined>,
): Promise<Completion> {
  let text = "";
  let thinking = "";
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let finishReason: string | undefined;

  for await (const delta of stream) {
    if (delta.type === "text") text += delta.text;
    else if (delta.type === "thinking") thinking += delta.text;
    else if (delta.type === "usage") usage = delta.usage;
    else finishReason = delta.reason;
  }

  return { text, thinking, usage, finishReason };
}
