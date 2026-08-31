import { query } from "@mini-agent/db";

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

export async function conversationMessages(conversationId: string) {
  return query<{ id: string; role: string; content: string; created_at: Date }>(
    `SELECT id::text, role, content #>> '{}' AS content, created_at
       FROM messages
      WHERE conversation_id = $1
      ORDER BY created_at ASC, id ASC`,
    [conversationId],
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
