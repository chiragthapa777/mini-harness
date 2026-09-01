import { getConfig } from "@mini-agent/config";
import { query, toVector } from "@mini-agent/db";
import { embed, scheduleEmbedding } from "./embeddings.js";

const TOP_K = getConfig().memory.ragTopK;
const RECENT_LIMIT = getConfig().memory.episodicRecentLimit;

export interface StoredMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  /** node-postgres maps timestamptz to a Date, not a string. */
  created_at: Date;
}

const SELECT_MESSAGE = `SELECT id::text, role, content #>> '{}' AS content, created_at FROM messages`;

/**
 * Episodic memory — past chat history and dated events. This is the one store
 * that needs both halves: RAG for relevance, SQL for recency. "What did we
 * discuss last Tuesday" is a timestamp question, not a similarity question.
 *
 * The recency half works with no embeddings configured; the relevance half
 * simply contributes nothing until one is.
 */
export async function recall(
  userId: string,
  prompt: string,
  topK = TOP_K,
): Promise<StoredMessage[]> {
  const vector = await embed(prompt);

  const recentPromise = query<StoredMessage>(
    `${SELECT_MESSAGE} WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, RECENT_LIMIT],
  );

  const relevantPromise = vector
    ? query<StoredMessage>(
        `${SELECT_MESSAGE}
          WHERE user_id = $1 AND embedding IS NOT NULL
          ORDER BY embedding <=> $2::vector
          LIMIT $3`,
        [userId, toVector(vector), topK],
      )
    : Promise.resolve<StoredMessage[]>([]);

  const [recent, relevant] = await Promise.all([recentPromise, relevantPromise]);

  const byId = new Map<string, StoredMessage>();
  for (const row of [...recent, ...relevant]) byId.set(row.id, row);
  return [...byId.values()].sort(
    (a, b) => a.created_at.getTime() - b.created_at.getTime(),
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
