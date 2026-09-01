import {
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  runAgent,
  runAgentStream,
  runConfig,
  type RunEvent,
  type RunResult,
  type Trace,
  type WorkingMemory,
} from "@mini-agent/core";
import { query } from "@mini-agent/db";
import {
  conversationHistory,
  conversationSummary,
  loadProcedural,
  recall,
  recallEvents,
  saveMessage,
  searchFacts,
} from "@mini-agent/memory";
import { toolsWithMcp } from "./tools.js";

export interface RunRequest {
  userId: string;
  conversationId: string;
  prompt: string;
}

/**
 * The run plus the id of the trace it wrote. A job that ran unattended has no
 * browser to show a trace to, so it hands the id back instead — that is what
 * lets the admin panel get from a failed job to the run behind it.
 */
export interface PersistedRun extends RunResult {
  traceId: string;
}

/**
 * One agent run: assemble working memory, run the loop, persist the reply to
 * episodic memory, and emit exactly one trace. Everything the loop held in
 * memory is discarded when this returns — only the stores and the trace survive.
 */
export async function run({
  userId,
  conversationId,
  prompt,
}: RunRequest): Promise<PersistedRun> {
  const [wm, tools] = await Promise.all([
    workingMemory(userId, prompt, conversationId),
    toolsWithMcp(userId),
  ]);
  const result = await runAgent(wm, tools, runConfig());

  const traceId = await persist({
    userId,
    conversationId,
    prompt,
    reply: result.reply,
    trace: result.trace,
  });
  return { ...result, traceId };
}

/**
 * The same run, yielded as it happens. Persistence is identical — the stream
 * is a view onto the run, not a different run.
 */
export async function* runStream({
  userId,
  conversationId,
  prompt,
}: RunRequest): AsyncGenerator<RunEvent, void, undefined> {
  const [wm, tools] = await Promise.all([
    workingMemory(userId, prompt, conversationId),
    toolsWithMcp(userId),
  ]);

  let reply = "";
  let trace: Trace | undefined;

  for await (const event of runAgentStream(wm, tools, runConfig())) {
    if (event.type === "reply") reply = event.text;
    if (event.type === "trace") trace = event.trace;
    yield event;
  }

  if (trace) await persist({ userId, conversationId, prompt, reply, trace });
}

/**
 * Inputs plus the three memory stores, assembled into the prompt. Retrieval is
 * per store, as it should be: procedural loads direct, semantic is RAG top-k,
 * and episodic is both — RAG over conversation summaries for relevance, SQL
 * over messages for the recent window.
 *
 * Chat history is the current conversation and nothing else. It used to be the
 * user's most recent messages across every thread, which handed the model a
 * transcript stitched together from unrelated conversations and asked it to
 * treat that as the dialogue it was in. Now the thread it is actually in is
 * replayed verbatim (last `historyLimit` turns), the older half of that thread
 * arrives as the conversation's rolling summary, and the user's other threads
 * stay where they belong — retrieved memory in the system prompt.
 *
 * With no conversation to scope to, history is empty rather than approximated:
 * a run with no thread has no dialogue to replay, and the memory stores still
 * supply everything else.
 */
async function workingMemory(
  userId: string,
  prompt: string,
  conversationId?: string,
): Promise<WorkingMemory> {
  const [procedural, facts, events, episodes, history, summary] = await Promise.all([
    loadProcedural(),
    searchFacts(userId, prompt),
    recallEvents(userId, prompt),
    recall(userId, undefined, conversationId),
    conversationId ? conversationHistory(conversationId) : [],
    conversationId ? conversationSummary(conversationId) : null,
  ]);

  return {
    systemPrompt: SYSTEM_PROMPT,
    procedural,
    semantic: facts.map((f) => f.content),
    // A recap is dated, not timestamped: the day is what makes it findable.
    events: events.map((e) => `${e.occurred_at.toISOString().slice(0, 10)} — ${e.summary}`),
    episodic: episodes.map((e) => `${e.created_at.toISOString()} ${e.role}: ${e.content}`),
    history: history.map((m) => ({
      role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: m.content,
    })),
    conversationSummary: summary ?? undefined,
    userPrompt: prompt,
  };
}

async function persist({
  userId,
  conversationId,
  prompt,
  reply,
  trace,
}: RunRequest & { reply: string; trace: Trace }): Promise<string> {
  await saveMessage(conversationId, userId, "user", prompt);
  if (reply) await saveMessage(conversationId, userId, "assistant", reply);
  return saveTrace(userId, conversationId, trace);
}

async function saveTrace(
  userId: string,
  conversationId: string,
  trace: Trace,
): Promise<string> {
  const [row] = await query<{ id: string }>(
    `INSERT INTO traces (conversation_id, user_id, model, prompt_version, system_prompt,
                         iterations, input_tokens, output_tokens, latency_ms, stop_reason,
                         error, steps)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
     RETURNING id::text`,
    [
      conversationId,
      userId,
      `${trace.provider}/${trace.model}`,
      PROMPT_VERSION,
      trace.systemPrompt,
      trace.iterations,
      trace.inputTokens,
      trace.outputTokens,
      trace.latencyMs,
      trace.stopReason,
      trace.error ?? null,
      JSON.stringify(trace.steps),
    ],
  );
  if (!row) throw new Error("failed to persist trace");
  return row.id;
}
