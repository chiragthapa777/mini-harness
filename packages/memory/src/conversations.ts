import { query } from "@mini-agent/db";

/**
 * Conversations are the container the episodic log hangs off, so they live in
 * the memory package rather than in one app's services: the API serves them to
 * the browser, and the worker needs the same helpers to run scheduled work
 * against a conversation.
 */

export interface ConversationRow {
  id: string;
  title: string | null;
  created_at: Date;
  message_count: number;
  last_message_at: Date | null;
}

export async function listConversations(userId: string): Promise<ConversationRow[]> {
  return query<ConversationRow>(
    `SELECT c.id::text,
            c.title,
            c.created_at,
            count(m.id)::int      AS message_count,
            max(m.created_at)     AS last_message_at
       FROM conversations c
       LEFT JOIN messages m ON m.conversation_id = c.id
      WHERE c.user_id = $1
      GROUP BY c.id
      ORDER BY coalesce(max(m.created_at), c.created_at) DESC`,
    [userId],
  );
}

export async function createConversation(userId: string, title?: string): Promise<string> {
  const [row] = await query<{ id: string }>(
    `INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING id::text`,
    [userId, title ?? null],
  );
  if (!row) throw new Error("failed to create conversation");
  return row.id;
}

/** Joined against `conversations` so a message list can never leak across users. */
export async function conversationMessages(conversationId: string, userId: string) {
  return query<{ id: string; role: string; content: string; created_at: Date }>(
    `SELECT m.id::text, m.role, m.content #>> '{}' AS content, m.created_at
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE m.conversation_id = $1 AND c.user_id = $2
      ORDER BY m.created_at ASC, m.id ASC`,
    [conversationId, userId],
  );
}

/** First user message doubles as the title until one is set explicitly. */
export async function titleFromFirstMessage(
  conversationId: string,
  prompt: string,
): Promise<void> {
  await query(
    `UPDATE conversations
        SET title = $2
      WHERE id = $1 AND title IS NULL`,
    [conversationId, prompt.slice(0, 60)],
  );
}

export async function deleteConversation(conversationId: string, userId: string): Promise<void> {
  await query(`DELETE FROM conversations WHERE id = $1 AND user_id = $2`, [
    conversationId,
    userId,
  ]);
}
