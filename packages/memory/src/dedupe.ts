import { getConfig } from "@mini-agent/config";
import { query } from "@mini-agent/db";
import { scheduleEmbedding } from "./embeddings.js";
import { FACT_MERGE_PROMPT } from "./prompts.js";
import { complete } from "./summarizer.js";

/**
 * Fact consolidation — the second half of the memory story.
 *
 * Consolidation writes facts; nothing used to take them away. "The user lives
 * in Kathmandu" arrived from five different conversations as five rows, all
 * competing for the same top-k slots, and a fact that *changed* never replaced
 * the one it contradicted.
 *
 * So: cluster near-duplicates by embedding distance, have a cheap model write
 * the one sentence that replaces the cluster, and archive the losers pointing
 * at the survivor. Nothing is deleted — a merge has to be reversible, and
 * "where did that fact go" has to have an answer.
 */

export interface DedupeResult {
  userId: string;
  clusters: number;
  merged: number;
  archived: number;
  capped: number;
  skipped?: string;
}

interface Pair {
  a: string;
  b: string;
}

/** Users whose fact count makes a pass worth the model call. */
export async function usersNeedingDedupe(
  minFacts = getConfig().memory.factDedupeMinFacts,
  limit = 50,
): Promise<{ user_id: string; facts: number }[]> {
  return query<{ user_id: string; facts: number }>(
    `SELECT user_id, count(*)::int AS facts
       FROM facts
      WHERE archived_at IS NULL
      GROUP BY user_id
     HAVING count(*) >= $1
      ORDER BY count(*) DESC
      LIMIT $2`,
    [minFacts, limit],
  );
}

/**
 * One dedup pass for one user. Safe to run repeatedly: a database with no
 * near-duplicates left produces no pairs, so it costs one query and no model
 * calls at all.
 */
export async function dedupeFacts(userId: string): Promise<DedupeResult> {
  const { factDedupeDistance, factMaxPerUser } = getConfig().memory;
  const result: DedupeResult = { userId, clusters: 0, merged: 0, archived: 0, capped: 0 };

  // pgvector does the distance work; only the pairs come back, not the vectors.
  const pairs = await query<Pair>(
    `SELECT a.id::text AS a, b.id::text AS b
       FROM facts a
       JOIN facts b
         ON b.user_id = a.user_id
        AND b.id > a.id
        AND b.archived_at IS NULL
        AND b.embedding IS NOT NULL
      WHERE a.user_id = $1
        AND a.archived_at IS NULL
        AND a.embedding IS NOT NULL
        AND a.embedding <=> b.embedding < $2
      ORDER BY a.embedding <=> b.embedding
      LIMIT 500`,
    [userId, factDedupeDistance],
  );

  for (const cluster of clusters(pairs)) {
    const merged = await mergeCluster(userId, cluster);
    if (!merged) continue;
    result.clusters++;
    result.merged += cluster.length;
    result.archived += cluster.length - 1;
  }

  result.capped = await enforceCap(userId, factMaxPerUser);
  return result;
}

/**
 * Union-find over the near-duplicate pairs. Transitivity is deliberate: if A
 * matches B and B matches C, all three describe the same thing even when A and
 * C fall outside the threshold on their own.
 */
function clusters(pairs: Pair[]): string[][] {
  const parent = new Map<string, string>();

  const find = (id: string): string => {
    const seen = parent.get(id) ?? id;
    if (seen === id) return id;
    const root = find(seen);
    parent.set(id, root);
    return root;
  };

  for (const { a, b } of pairs) {
    parent.set(a, parent.get(a) ?? a);
    parent.set(b, parent.get(b) ?? b);
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  }

  const grouped = new Map<string, string[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    grouped.set(root, [...(grouped.get(root) ?? []), id]);
  }

  return [...grouped.values()].filter((group) => group.length > 1);
}

/**
 * Merge one cluster into its oldest row. Oldest wins so references stay
 * stable; the *content* comes from the model, which is told to resolve a
 * contradiction by recency rather than keeping both halves.
 */
async function mergeCluster(userId: string, ids: string[]): Promise<boolean> {
  const facts = await query<{ id: string; content: string; updated_at: Date }>(
    `SELECT id::text, content, updated_at
       FROM facts
      WHERE id = ANY($1::bigint[]) AND user_id = $2 AND archived_at IS NULL
      ORDER BY updated_at ASC`,
    [ids, userId],
  );
  // Another pass may have archived half the cluster since the pairs were read.
  if (facts.length < 2) return false;

  const survivor = facts.reduce((oldest, fact) =>
    BigInt(fact.id) < BigInt(oldest.id) ? fact : oldest,
  );

  // Oldest first, so "the most recent one wins" is a position the model can see.
  const rendered = facts
    .map((fact) => `- (${fact.updated_at.toISOString().slice(0, 10)}) ${fact.content}`)
    .join("\n");

  const merged = (await complete(FACT_MERGE_PROMPT, rendered)).split("\n")[0]?.trim();
  if (!merged) return false;

  await query(
    `UPDATE facts
        SET content = $2, updated_at = now(), embedding = NULL
      WHERE id = $1`,
    [survivor.id, merged],
  );
  // The text changed, so the old vector is wrong until this lands.
  await scheduleEmbedding("facts", survivor.id);

  const losers = facts.filter((fact) => fact.id !== survivor.id).map((fact) => fact.id);
  await query(
    `UPDATE facts
        SET archived_at = now(), superseded_by = $2, updated_at = now()
      WHERE id = ANY($1::bigint[])`,
    [losers, survivor.id],
  );

  return true;
}

/**
 * Hard ceiling on active facts per user. Least recently updated go first —
 * `updated_at` is touched every time a fact is re-derived or merged, so it is
 * the closest thing to "still relevant" the table has.
 */
async function enforceCap(userId: string, max: number): Promise<number> {
  const archived = await query<{ id: string }>(
    `UPDATE facts
        SET archived_at = now()
      WHERE id IN (
        SELECT id FROM facts
         WHERE user_id = $1 AND archived_at IS NULL
         ORDER BY updated_at DESC
         OFFSET $2
      )
      RETURNING id::text`,
    [userId, max],
  );
  return archived.length;
}
