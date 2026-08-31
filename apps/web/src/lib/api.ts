import type { Conversation, StoredMessage, StreamEvent, Trace } from "./types.js";

export const USER_ID = "local";

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export const listConversations = () =>
  json<Conversation[]>(`/conversations?userId=${USER_ID}`);

export const createConversation = () =>
  json<{ id: string }>("/conversations", {
    method: "POST",
    body: JSON.stringify({ userId: USER_ID }),
  });

export const loadMessages = (id: string) =>
  json<StoredMessage[]>(`/conversations/${id}/messages`);

export const deleteConversation = (id: string) =>
  fetch(`/api/conversations/${id}?userId=${USER_ID}`, { method: "DELETE" });

export const sendChat = (prompt: string, conversationId?: string) =>
  json<{ conversationId: string; reply: string; trace: Trace }>("/chat", {
    method: "POST",
    body: JSON.stringify({ userId: USER_ID, conversationId, prompt }),
  });

/**
 * SSE over POST, so it cannot use EventSource (GET only). Frames are
 * `event: <name>\ndata: <json>\n\n`; we only need the data line.
 */
export async function* streamChat(
  prompt: string,
  conversationId: string | undefined,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent, void, undefined> {
  const response = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: USER_ID, conversationId, prompt }),
    signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`stream failed: ${response.status} ${response.statusText}`);
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  while (true) {
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
