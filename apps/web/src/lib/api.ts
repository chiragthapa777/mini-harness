import type { Conversation, StoredMessage, StreamEvent, Trace } from "./types.js";

const TOKEN_KEY = "mini-agent:token";

export interface AuthUser {
  id: string;
  email: string;
  role: "user" | "admin";
}

export const getToken = (): string | null => localStorage.getItem(TOKEN_KEY);
export const setToken = (token: string): void => localStorage.setItem(TOKEN_KEY, token);
export const clearToken = (): void => localStorage.removeItem(TOKEN_KEY);

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    headers: { "content-type": "application/json", ...authHeaders() },
    ...init,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export const login = (email: string, password: string) =>
  json<{ token: string; user: AuthUser }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });

export const me = () => json<AuthUser>("/auth/me");

export interface AdminUser {
  id: string;
  email: string;
  role: "user" | "admin";
  failed_login_attempts: number;
  locked_until: string | null;
  created_at: string;
}

export const adminListUsers = () => json<AdminUser[]>("/admin/users");

export const adminCreateUser = (email: string, password: string, role: "user" | "admin") =>
  json<{ id: string; email: string; role: "user" | "admin" }>("/admin/users", {
    method: "POST",
    body: JSON.stringify({ email, password, role }),
  });

export const listConversations = () => json<Conversation[]>("/conversations");

export const createConversation = () =>
  json<{ id: string }>("/conversations", { method: "POST" });

export const loadMessages = (id: string) => json<StoredMessage[]>(`/conversations/${id}/messages`);

export const deleteConversation = (id: string) =>
  fetch(`/api/conversations/${id}`, { method: "DELETE", headers: authHeaders() });

export const sendChat = (prompt: string, conversationId?: string) =>
  json<{ conversationId: string; reply: string; trace: Trace }>("/chat", {
    method: "POST",
    body: JSON.stringify({ conversationId, prompt }),
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
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ conversationId, prompt }),
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
