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
import { loadProcedural, recall, saveMessage, searchFacts } from "@mini-agent/memory";
import { toolsFor } from "./tools.js";

export interface RunRequest {
  userId: string;
  conversationId: string;
  prompt: string;
}

/**
 * One agent run: assemble working memory, run the loop, persist the reply to
 * episodic memory, and emit exactly one trace. Everything the loop held in
 * memory is discarded when this returns — only the stores and the trace survive.
 */
export async function run({ userId, conversationId, prompt }: RunRequest): Promise<RunResult> {
  const wm = await workingMemory(userId, prompt);
  const result = await runAgent(wm, toolsFor(userId), runConfig());

  await persist({ userId, conversationId, prompt, reply: result.reply, trace: result.trace });
  return result;
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
  const wm = await workingMemory(userId, prompt);

  let reply = "";
  let trace: Trace | undefined;

  for await (const event of runAgentStream(wm, toolsFor(userId), runConfig())) {
    if (event.type === "reply") reply = event.text;
    if (event.type === "trace") trace = event.trace;
    yield event;
  }

  if (trace) await persist({ userId, conversationId, prompt, reply, trace });
}

/** Inputs plus the three memory stores, assembled into the prompt. */
async function workingMemory(userId: string, prompt: string): Promise<WorkingMemory> {
  const [procedural, facts, episodes] = await Promise.all([
    loadProcedural(),
    searchFacts(userId, prompt),
    recall(userId, prompt),
  ]);

  return {
    systemPrompt: SYSTEM_PROMPT,
    procedural,
    semantic: facts.map((f) => f.content),
    episodic: episodes.map((e) => `${e.created_at.toISOString()} ${e.role}: ${e.content}`),
    history: episodes.map((m) => ({
      role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: m.content,
    })),
    userPrompt: prompt,
  };
}

async function persist({
  userId,
  conversationId,
  prompt,
  reply,
  trace,
}: RunRequest & { reply: string; trace: Trace }): Promise<void> {
  await saveMessage(conversationId, userId, "user", prompt);
  if (reply) await saveMessage(conversationId, userId, "assistant", reply);
  await saveTrace(userId, conversationId, trace);
}

async function saveTrace(
  userId: string,
  conversationId: string,
  trace: Trace,
): Promise<void> {
  await query(
    `INSERT INTO traces (conversation_id, user_id, model, prompt_version, system_prompt,
                         iterations, input_tokens, output_tokens, latency_ms, stop_reason,
                         error, steps)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
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
}
