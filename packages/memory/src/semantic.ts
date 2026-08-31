import { query, toVector } from "@mini-agent/db";
import { embed } from "./embeddings.js";

const TOP_K = Number(process.env.RAG_TOP_K ?? 5);

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

/** Written by the summarizer agent, never by the run loop. */
export async function writeFact(
  userId: string,
  content: string,
  kind: Fact["kind"] = "fact",
  source?: string,
): Promise<void> {
  const vector = await embed(content);
  await query(
    `INSERT INTO facts (user_id, kind, content, source, embedding)
     VALUES ($1, $2, $3, $4, $5::vector)`,
    [userId, kind, content, source ?? null, vector ? toVector(vector) : null],
  );
}
