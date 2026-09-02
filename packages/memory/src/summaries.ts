import { getConfig } from "@mini-agent/config";
import { query } from "@mini-agent/db";
import { scheduleEmbedding } from "./embeddings.js";
import type { StoredMessage } from "./episodic.js";
import { conversationSummaryPrompt } from "./prompts.js";
import { capWords, complete } from "./summarizer.js";

/**
 * Conversation summaries, and the episodic events they become.
 *
 * Episodic retrieval used to rank individual turns, which meant one chatty
 * thread could fill every slot and a two-line answer competed with the
 * conversation it came from. A conversation gets one rolling recap instead,
 * and that recap is the dated event RAG ranks.
 *
 * The whole thing is driven off a watermark (`summary_message_id`): a job
 * reads the messages past it, rewrites the summary, and moves it. A job that
 * dies leaves the watermark where it was and is simply picked up next tick.
 */

export interface ConversationSummary {
  id: string;
  user_id: string;
  summary: string | null;
  summary_message_id: string | null;
}

/**
 * One conversation's current recap, or null if a summary job has not run for
 * it yet (a short thread that fits entirely in the replayed history never
 * needs one). Read on the chat path, so it is a single indexed lookup and
 * never triggers summarization itself — a run must not wait on a model call
 * that a background job already owns.
 */
export async function conversationSummary(conversationId: string): Promise<string | null> {
  const [row] = await query<{ summary: string | null }>(
    `SELECT summary FROM conversations WHERE id = $1`,
    [conversationId],
  );
  return row?.summary ?? null;
}

/**
 * Conversations with messages the summary has not seen. Cheap enough to run
 * every five minutes: an idle system matches nothing and enqueues nothing.
 */
export async function conversationsNeedingSummary(
  limit = 50,
): Promise<{ id: string; user_id: string; pending: number }[]> {
  return query<{ id: string; user_id: string; pending: number }>(
    `SELECT c.id::text, c.user_id, count(m.id)::int AS pending
       FROM conversations c
       JOIN messages m ON m.conversation_id = c.id
      WHERE m.id > coalesce(c.summary_message_id, 0)
      GROUP BY c.id
      ORDER BY max(m.created_at) DESC
      LIMIT $1`,
    [limit],
  );
}

export interface SummarizeResult {
  conversationId: string;
  skipped?: string;
  messages?: number;
  words?: number;
  eventId?: string;
}

/**
 * Rewrite one conversation's summary and upsert its episodic event.
 *
 * Idempotent by construction: if nothing is newer than the watermark it does
 * no model call at all, so a duplicate job is free.
 */
export async function summarizeConversation(conversationId: string): Promise<SummarizeResult> {
  const { summaryMaxWords, summaryMaxMessages } = getConfig().memory;

  const [conversation] = await query<ConversationSummary>(
    `SELECT id::text, user_id, summary, summary_message_id::text
       FROM conversations WHERE id = $1`,
    [conversationId],
  );
  if (!conversation) return { conversationId, skipped: "conversation is gone" };

  // Newest N, then flipped back into reading order: a long thread is summarised
  // from its recent end, with the previous summary carrying the older half.
  const recent = await query<StoredMessage>(
    `SELECT id::text, role, content #>> '{}' AS content, created_at
       FROM messages
      WHERE conversation_id = $1
      ORDER BY id DESC
      LIMIT $2`,
    [conversationId, summaryMaxMessages],
  );
  if (recent.length === 0) return { conversationId, skipped: "no messages" };

  const messages = [...recent].reverse();
  const latestId = recent[0]!.id;
  const occurredAt = recent[0]!.created_at;

  // The watermark is the whole gate — nothing new means no model call.
  if (conversation.summary_message_id && BigInt(latestId) <= BigInt(conversation.summary_message_id)) {
    return { conversationId, skipped: "already summarized" };
  }

  const summary = capWords(
    await complete(conversationSummaryPrompt(summaryMaxWords), render(messages, conversation.summary)),
    summaryMaxWords,
  );
  if (!summary) return { conversationId, skipped: "summarizer returned nothing" };

  await query(
    `UPDATE conversations
        SET summary = $2, summary_updated_at = now(), summary_message_id = $3
      WHERE id = $1`,
    [conversationId, summary, latestId],
  );

  const eventId = await upsertEvent(conversation.user_id, conversationId, summary, occurredAt);
  return {
    conversationId,
    messages: messages.length,
    words: summary.split(/\s+/).length,
    eventId,
  };
}

/**
 * One event per conversation. Regenerating the summary updates that row and
 * clears its embedding, so the vector is never stale relative to the text it
 * is supposed to represent — the re-embed is queued right after.
 */
async function upsertEvent(
  userId: string,
  conversationId: string,
  summary: string,
  occurredAt: Date,
): Promise<string> {
  const [row] = await query<{ id: string }>(
    `INSERT INTO events (user_id, conversation_id, summary, occurred_at)
     VALUES ($1, $2, $3, $4)
     -- The unique index is partial, so the predicate has to be repeated here
     -- or Postgres cannot infer which index this conflict targets.
     ON CONFLICT (conversation_id) WHERE conversation_id IS NOT NULL DO UPDATE
        SET summary = EXCLUDED.summary,
            occurred_at = EXCLUDED.occurred_at,
            embedding = NULL
     RETURNING id::text`,
    [userId, conversationId, summary, occurredAt],
  );
  if (!row) throw new Error("failed to upsert episodic event");

  await scheduleEmbedding("events", row.id);
  return row.id;
}

/** What the model reads: the previous recap, then the turns it has not seen. */
function render(messages: StoredMessage[], previousSummary: string | null): string {
  const transcript = messages
    .map((m) => `${m.created_at.toISOString()} ${m.role}: ${m.content}`)
    .join("\n");

  return previousSummary
    ? `Earlier summary of this conversation:\n${previousSummary}\n\nConversation:\n${transcript}`
    : `Conversation:\n${transcript}`;
}
