import { getConfig } from "@mini-agent/config";
import { query, toVector } from "@mini-agent/db";
import { embed, scheduleEmbedding } from "./embeddings.js";

const TOP_K = getConfig().memory.ragTopK;
const RECENT_LIMIT = getConfig().memory.episodicRecentLimit;
const HISTORY_LIMIT = getConfig().memory.historyLimit;

export interface StoredMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  /** node-postgres maps timestamptz to a Date, not a string. */
  created_at: Date;
}

const SELECT_MESSAGE = `SELECT id::text, role, content #>> '{}' AS content, created_at FROM messages`;

/**
 * Episodic memory — what happened, in two halves that answer different
 * questions. "What were we just saying" is a timestamp question, answered by
 * `recall` below: the most recent turns, verbatim, no embedding needed.
 * "What did we decide about the Pokhara trip" is a similarity question,
 * answered by `recallEvents`, which ranks conversation summaries rather than
 * individual turns — see `summaries.ts` for why.
 */
export async function recall(
  userId: string,
  limit = RECENT_LIMIT,
  excludeConversationId?: string,
): Promise<StoredMessage[]> {
  // The current conversation is replayed verbatim as chat history, so
  // including it here would send the same turns twice in one prompt. Excluding
  // it leaves this query doing what its heading claims: what happened
  // *elsewhere*, recently.
  const recent = excludeConversationId
    ? await query<StoredMessage>(
        `${SELECT_MESSAGE}
          WHERE user_id = $1 AND conversation_id <> $3
          ORDER BY created_at DESC LIMIT $2`,
        [userId, limit, excludeConversationId],
      )
    : await query<StoredMessage>(
        `${SELECT_MESSAGE} WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [userId, limit],
      );
  return recent.reverse();
}

/**
 * The current conversation, verbatim, newest `limit` turns in reading order.
 *
 * This is the chat history the model is replayed — scoped to one conversation
 * on purpose. A user-wide recent window mixed unrelated threads into the
 * transcript, which reads to the model as one incoherent conversation. What
 * fell off the front of this window is not lost: it is what the conversation's
 * rolling summary carries (`conversationSummary` in `summaries.ts`).
 */
export async function conversationHistory(
  conversationId: string,
  limit = HISTORY_LIMIT,
): Promise<StoredMessage[]> {
  const recent = await query<StoredMessage>(
    `${SELECT_MESSAGE}
      WHERE conversation_id = $1 AND role IN ('user', 'assistant')
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [conversationId, limit],
  );
  return recent.reverse();
}

/** One conversation's summary, as an episodic event. */
export interface StoredEvent {
  id: string;
  summary: string;
  occurred_at: Date;
  conversation_id: string | null;
}

/**
 * The relevance half: RAG over conversation summaries. One row per
 * conversation means a long thread gets one slot, not fifty, so top-k spends
 * its budget on distinct episodes.
 *
 * Falls back to the most recent events when embeddings are not configured —
 * less relevant recall beats a failed run.
 */
export async function recallEvents(
  userId: string,
  prompt: string,
  topK = TOP_K,
): Promise<StoredEvent[]> {
  const vector = await embed(prompt);

  if (!vector) {
    return query<StoredEvent>(
      `SELECT id::text, summary, occurred_at, conversation_id::text
         FROM events WHERE user_id = $1
        ORDER BY occurred_at DESC LIMIT $2`,
      [userId, topK],
    );
  }

  return query<StoredEvent>(
    `SELECT id::text, summary, occurred_at, conversation_id::text
       FROM events
      WHERE user_id = $1 AND embedding IS NOT NULL
      ORDER BY embedding <=> $2::vector
      LIMIT $3`,
    [userId, toVector(vector), topK],
  );
}

/**
 * Turn-level relevance search. No longer part of automatic recall — it is what
 * the agent's `search_memory` tool reaches for when the summary of an episode
 * is not enough and it needs the exact words.
 */
export async function searchMessages(
  userId: string,
  prompt: string,
  topK = TOP_K,
): Promise<StoredMessage[]> {
  const vector = await embed(prompt);
  if (!vector) return [];

  return query<StoredMessage>(
    `${SELECT_MESSAGE}
      WHERE user_id = $1 AND embedding IS NOT NULL
      ORDER BY embedding <=> $2::vector
      LIMIT $3`,
    [userId, toVector(vector), topK],
  );
}

/**
 * Every reply is saved here. The episodic store is the append-only log.
 *
 * The row lands with a null embedding and the vector is filled in by a job:
 * the chat path should not wait on an embedding round-trip for something no
 * reader needs yet (`recall` skips rows without one). Returns the new id.
 */
export async function saveMessage(
  conversationId: string,
  userId: string,
  role: StoredMessage["role"],
  content: string,
): Promise<string> {
  const [row] = await query<{ id: string }>(
    `INSERT INTO messages (conversation_id, user_id, role, content)
     VALUES ($1, $2, $3, to_jsonb($4::text))
     RETURNING id::text`,
    [conversationId, userId, role, content],
  );
  if (!row) throw new Error("failed to save message");

  await scheduleEmbedding("messages", row.id);
  return row.id;
}

export async function unconsolidated(userId: string): Promise<StoredMessage[]> {
  return query<StoredMessage>(
    `${SELECT_MESSAGE}
      WHERE user_id = $1 AND consolidated_at IS NULL
      ORDER BY created_at ASC`,
    [userId],
  );
}

export async function markConsolidated(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await query(
    `UPDATE messages SET consolidated_at = now() WHERE id = ANY($1::bigint[])`,
    [ids],
  );
}
