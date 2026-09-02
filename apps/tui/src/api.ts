import { getConfig } from "@mini-agent/config";

/**
 * The TUI is a gateway like the web app: it holds no harness logic and calls
 * the same endpoints. Anything it could do that the browser cannot would be a
 * second implementation of the agent, which is exactly what `packages/` exists
 * to prevent.
 */
const baseUrl = () => getConfig().web.apiUrl.replace(/\/$/, "");

export interface AuthUser {
  id: string;
  email: string;
  role: "user" | "admin";
}

export interface Conversation {
  id: string;
  title: string | null;
  message_count: number;
  last_message_at: string | null;
}

/** Mirrors `RunEvent` in `@mini-agent/core`, plus the two transport events. */
export type StreamEvent =
  | { type: "conversation"; conversationId: string }
  | { type: "run_start"; provider: string; model: string }
  | { type: "iteration_start"; iteration: number }
  | { type: "thinking_delta"; text: string }
  | { type: "text_delta"; text: string }
  | { type: "iteration_end"; iteration: number }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; output: string; isError: boolean }
  | { type: "guardrail"; reason: string }
  | { type: "reply"; text: string }
  | { type: "trace"; trace: { iterations: number; inputTokens: number; outputTokens: number } }
  | { type: "error"; message: string }
  | { type: "done" };

async function request<T>(path: string, token: string | null, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export const login = (email: string, password: string) =>
  request<{ token: string; user: AuthUser }>("/auth/login", null, {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });

export const me = (token: string) => request<AuthUser>("/auth/me", token);

export const listConversations = (token: string) =>
  request<Conversation[]>("/conversations", token);

/**
 * The same SSE-over-POST stream the web app consumes. Frames are
 * `event: <name>\ndata: <json>\n\n`; only the data line matters.
 */
export async function* streamChat(
  token: string,
  prompt: string,
  conversationId: string | undefined,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent, void, undefined> {
  const response = await fetch(`${baseUrl()}/chat/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ conversationId, prompt }),
    signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`stream failed: ${response.status} ${response.statusText}`);
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += value;
    // A frame is complete only at a blank line; anything after is a partial.
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const data = frame
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
        .trim();
      if (!data) continue;
      yield JSON.parse(data) as StreamEvent;
    }
  }
}
