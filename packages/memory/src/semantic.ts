import { getConfig } from "@mini-agent/config";
import { query, toVector } from "@mini-agent/db";
import { embed, scheduleEmbedding } from "./embeddings.js";

const TOP_K = getConfig().memory.ragTopK;

export interface Fact {
  id: string;
  content: string;
  kind: string;
}

/**
 * Semantic memory — durable facts, user profile, domain rules. Retrieval is
 * pure relevance: RAG top-k. Recency does not matter here, so without
 * embeddings the best we can do is hand back the newest facts.
 */
export async function searchFacts(
  userId: string,
  prompt: string,
  topK = TOP_K,
): Promise<Fact[]> {
  const vector = await embed(prompt);

  if (!vector) {
    return query<Fact>(
      `SELECT id::text, content, kind
         FROM facts
        WHERE user_id = $1
        ORDER BY updated_at DESC
        LIMIT $2`,
      [userId, topK],
    );
  }

  return query<Fact>(
    `SELECT id::text, content, kind
       FROM facts
      WHERE user_id = $1 AND embedding IS NOT NULL
      ORDER BY embedding <=> $2::vector
      LIMIT $3`,
    [userId, toVector(vector), topK],
  );
}

export interface AdminFact extends Fact {
  user_id: string;
  source: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Admin listing — every fact for a user, newest first, no relevance ranking.
 * This is "show me the memory", not retrieval for a prompt, so it takes no
 * query vector and pages by offset instead of RAG top-k.
 */
export async function listFacts(
  userId: string,
  { kind, limit = 20, offset = 0 }: { kind?: string; limit?: number; offset?: number } = {},
): Promise<{ facts: AdminFact[]; total: number }> {
  const kindFilter = kind ? `AND kind = $2` : "";
  const params = kind ? [userId, kind, limit, offset] : [userId, limit, offset];
  const limitIdx = kind ? 3 : 2;
  const offsetIdx = kind ? 4 : 3;

  const [facts, countRows] = await Promise.all([
    query<AdminFact>(
      `SELECT id::text, user_id, kind, content, source, created_at, updated_at
         FROM facts
        WHERE user_id = $1 ${kindFilter}
        ORDER BY updated_at DESC
        LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    ),
    query<{ count: string }>(
      `SELECT count(*)::text FROM facts WHERE user_id = $1 ${kindFilter}`,
      kind ? [userId, kind] : [userId],
    ),
  ]);

  return { facts, total: Number(countRows[0]?.count ?? 0) };
}

/**
 * Written by the summarizer agent and the agent's own `remember` tool, never by
 * the run loop itself. Like `saveMessage`, the embedding is filled in by a job
 * rather than on the caller's clock.
 */
export async function writeFact(
  userId: string,
  content: string,
  kind: Fact["kind"] = "fact",
  source?: string,
): Promise<string> {
  const [row] = await query<{ id: string }>(
    `INSERT INTO facts (user_id, kind, content, source)
     VALUES ($1, $2, $3, $4)
     RETURNING id::text`,
    [userId, kind, content, source ?? null],
  );
  if (!row) throw new Error("failed to write fact");

  await scheduleEmbedding("facts", row.id);
  return row.id;
}
