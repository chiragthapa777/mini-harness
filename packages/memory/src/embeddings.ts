import { query, toVector } from "@mini-agent/db";
import { enqueue, jobsEnabled, type EmbeddableTable } from "@mini-agent/jobs";
import { EMBEDDING_DIMENSIONS, embedQuery, embeddingsConfigured } from "@mini-agent/llm";

/** Embedding dimension must match the vector(n) columns in schema.sql. */
export { EMBEDDING_DIMENSIONS, embeddingsConfigured };
export type { EmbeddableTable };

let warned = false;

/**
 * Returns null when embeddings are not configured. Callers fall back to plain
 * SQL recency: the agent keeps working with less relevant recall rather than
 * failing the run outright.
 *
 * The transport lives in `@mini-agent/llm`; this wrapper owns only that policy.
 */
export async function embed(text: string): Promise<number[] | null> {
  if (!embeddingsConfigured()) {
    if (!warned) {
      warned = true;
      console.warn(
        "[memory] no embeddings key set — semantic search is off, " +
          "memory falls back to recency. Set EMBEDDINGS_API_KEY to enable RAG.",
      );
    }
    return null;
  }
  return embedQuery(text);
}

/**
 * Where the text to embed lives, per table. One generic job covers all three
 * because the only thing that differs is this expression.
 */
const TEXT_COLUMN: Record<EmbeddableTable, string> = {
  messages: `content #>> '{}'`,
  facts: "content",
  events: "summary",
};

/**
 * Called after inserting a row with a null embedding.
 *
 * An embedding is a network round-trip, and nothing on the read path needs it
 * to have landed — `recall` and `searchFacts` both filter
 * `embedding IS NOT NULL`, so an un-embedded row degrades to recency-only
 * instead of breaking. That is what makes deferring it safe.
 *
 * With no worker deployed (`JOBS_ENABLED=false`) it happens inline instead, so
 * behaviour is the same either way — only the latency moves.
 */
export async function scheduleEmbedding(table: EmbeddableTable, id: string): Promise<void> {
  if (!embeddingsConfigured()) return;

  if (!jobsEnabled()) {
    await embedRow(table, id);
    return;
  }

  await enqueue("embed_row", { table, id }, { dedupeKey: `embed:${table}:${id}` });
}

/**
 * Fill in one row's embedding. Idempotent: a row that already has one (or that
 * has since been deleted) is a no-op, so a duplicate job costs a query rather
 * than a second embedding call.
 */
export async function embedRow(
  table: EmbeddableTable,
  id: string,
): Promise<{ embedded: boolean; reason?: string }> {
  if (!embeddingsConfigured()) return { embedded: false, reason: "embeddings not configured" };

  const [row] = await query<{ text: string | null }>(
    `SELECT ${TEXT_COLUMN[table]} AS text FROM ${table} WHERE id = $1 AND embedding IS NULL`,
    [id],
  );
  if (!row) return { embedded: false, reason: "row is gone or already embedded" };
  if (!row.text?.trim()) return { embedded: false, reason: "nothing to embed" };

  const vector = await embed(row.text);
  if (!vector) return { embedded: false, reason: "embedding unavailable" };

  await query(`UPDATE ${table} SET embedding = $2::vector WHERE id = $1`, [id, toVector(vector)]);
  return { embedded: true };
}

/**
 * Safety net for rows whose embed job was lost — a worker killed before the
 * queue's retry policy could apply, or a row written while the worker was
 * down. Runs on a schedule and only looks at rows old enough that their
 * original job should have finished by now.
 */
export async function backfillEmbeddings(limit = 200): Promise<{ enqueued: number }> {
  if (!embeddingsConfigured()) return { enqueued: 0 };

  const tables: EmbeddableTable[] = ["messages", "facts", "events"];
  let enqueued = 0;

  for (const table of tables) {
    const rows = await query<{ id: string }>(
      `SELECT id::text FROM ${table}
        WHERE embedding IS NULL AND created_at < now() - interval '5 minutes'
        ORDER BY created_at
        LIMIT $1`,
      [limit],
    );

    for (const row of rows) {
      // The dedupe key means a row whose first job is still queued is skipped
      // rather than queued twice.
      if (await enqueue("embed_row", { table, id: row.id }, { dedupeKey: `embed:${table}:${row.id}` })) {
        enqueued++;
      }
    }
  }

  return { enqueued };
}
