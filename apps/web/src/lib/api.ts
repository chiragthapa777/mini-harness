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

export const adminUpdateUser = (id: string, patch: { role?: "user" | "admin"; unlock?: boolean }) =>
  json<{ id: string; email: string; role: "user" | "admin" }>(`/admin/users/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });

export interface AdminFact {
  id: string;
  user_id: string;
  kind: string;
  content: string;
  source: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  superseded_by: string | null;
}

export const adminListFacts = (
  userId: string,
  opts: { kind?: string; includeArchived?: boolean; limit?: number; offset?: number } = {},
) =>
  json<{ facts: AdminFact[]; total: number }>(
    `/admin/facts?${qs({ userId, ...opts })}`,
  );

/**
 * The file is read in the browser and posted as text: .txt/.md is a string,
 * and that keeps multipart handling out of the server for no loss.
 */
export const adminUploadFacts = (
  userId: string,
  filename: string,
  content: string,
  kind = "data_dictionary",
) =>
  json<{ filename: string; chunks: number; factIds: string[] }>("/admin/facts/upload", {
    method: "POST",
    body: JSON.stringify({ userId, filename, content, kind }),
  });

export interface AdminTrace {
  id: string;
  conversation_id: string | null;
  user_id: string;
  model: string;
  prompt_version: string | null;
  system_prompt: string | null;
  iterations: number;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number | null;
  stop_reason: string | null;
  error: string | null;
  created_at: string;
}

export interface AdminTraceDetail extends AdminTrace {
  steps: Trace["steps"];
}

export const adminListTraces = (
  filters: {
    userId?: string;
    model?: string;
    errorOnly?: boolean;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  } = {},
) => json<{ traces: AdminTrace[]; total: number }>(`/admin/traces?${qs(filters)}`);

export const adminGetTrace = (id: string) => json<AdminTraceDetail>(`/admin/traces/${id}`);

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface AdminJob {
  id: string;
  type: string;
  user_id: string | null;
  payload: unknown;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  dedupe_key: string | null;
  result: unknown;
  scheduled_for: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export const adminListJobs = (
  filters: {
    status?: JobStatus;
    type?: string;
    userId?: string;
    limit?: number;
    offset?: number;
  } = {},
) => json<{ jobs: AdminJob[]; total: number }>(`/admin/jobs?${qs(filters)}`);

export const adminJobStats = () =>
  json<{ status: JobStatus; type: string; count: number }[]>("/admin/jobs/stats");

export const adminRetryJob = (id: string) =>
  json<AdminJob>(`/admin/jobs/${id}/retry`, { method: "POST" });

export interface Schedule {
  id: string;
  kind: "system" | "user";
  key: string | null;
  user_id: string | null;
  name: string;
  job_type: string;
  prompt: string | null;
  cron: string;
  enabled: boolean;
  last_run_at: string | null;
  last_job_id: string | null;
  next_run_at: string | null;
  created_at: string;
}

export const listSchedules = () => json<Schedule[]>("/schedules");

export const createSchedule = (input: { name: string; prompt: string; cron: string }) =>
  json<Schedule>("/schedules", { method: "POST", body: JSON.stringify(input) });

export const updateSchedule = (
  id: string,
  patch: { name?: string; prompt?: string; cron?: string; enabled?: boolean },
) => json<Schedule>(`/schedules/${id}`, { method: "PATCH", body: JSON.stringify(patch) });

export const removeSchedule = (id: string) =>
  fetch(`/api/schedules/${id}`, { method: "DELETE", headers: authHeaders() });

/** Next few firings for a cron expression — validation the user can actually read. */
export const previewCron = (cron: string) =>
  json<{ cron: string; runs: string[] }>(`/schedules/preview?${qs({ cron })}`);

export const adminListSchedules = () => json<Schedule[]>("/admin/schedules");

export const adminSetScheduleEnabled = (id: string, enabled: boolean) =>
  json<Schedule>(`/admin/schedules/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  });

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  return search.toString();
}

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
