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
 * Every read path filters archived rows. A superseded fact is kept for the
 * audit trail, not to be retrieved — retrieving it would put the stale half of
 * a merge back in front of the model.
 */
const ACTIVE = "archived_at IS NULL";

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
        WHERE user_id = $1 AND ${ACTIVE}
        ORDER BY updated_at DESC
        LIMIT $2`,
      [userId, topK],
    );
  }

  return query<Fact>(
    `SELECT id::text, content, kind
       FROM facts
      WHERE user_id = $1 AND ${ACTIVE} AND embedding IS NOT NULL
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
  archived_at: Date | null;
  superseded_by: string | null;
}

/**
 * Admin listing — every fact for a user, newest first, no relevance ranking.
 * This is "show me the memory", not retrieval for a prompt, so it takes no
 * query vector and pages by offset instead of RAG top-k.
 */
export async function listFacts(
  userId: string,
  {
    kind,
    includeArchived = false,
    limit = 20,
    offset = 0,
  }: { kind?: string; includeArchived?: boolean; limit?: number; offset?: number } = {},
): Promise<{ facts: AdminFact[]; total: number }> {
  const filters: string[] = [];
  const params: unknown[] = [userId];

  if (kind) {
    params.push(kind);
    filters.push(`AND kind = $${params.length}`);
  }
  // Archived facts are hidden by default but reachable: without them a merge
  // looks like data loss to whoever is reading the memory tab.
  if (!includeArchived) filters.push(`AND ${ACTIVE}`);
  const where = `WHERE user_id = $1 ${filters.join(" ")}`;

  const [facts, countRows] = await Promise.all([
    query<AdminFact>(
      `SELECT id::text, user_id, kind, content, source, created_at, updated_at,
              archived_at, superseded_by::text
         FROM facts
        ${where}
        ORDER BY updated_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    ),
    query<{ count: string }>(`SELECT count(*)::text FROM facts ${where}`, params),
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
  // Cheap exact-match dedup first: consolidation re-derives the same sentence
  // from overlapping batches all the time, and touching `updated_at` says "seen
  // again" without spending a row or an embedding call on it. Near-duplicates
  // need the vector, so they are the dedupe job's problem (`dedupe.ts`).
  const [existing] = await query<{ id: string }>(
    `UPDATE facts
        SET updated_at = now(), source = coalesce($4, source)
      WHERE user_id = $1 AND kind = $2 AND ${ACTIVE}
        AND lower(btrim(content)) = lower(btrim($3))
      RETURNING id::text`,
    [userId, kind, content, source ?? null],
  );
  if (existing) return existing.id;

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
