import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { close, query } from "@mini-agent/db";
import { createConversation } from "../src/conversations.js";
import { embeddingsConfigured, embedRow, backfillEmbeddings } from "../src/embeddings.js";
import { saveMessage } from "../src/episodic.js";
import { writeFact } from "../src/semantic.js";

/**
 * Real Postgres or nothing — the point of these tests is the SQL contract
 * between "insert now, embed later" and the readers that filter on
 * `embedding IS NOT NULL`.
 */
const configured = Boolean(process.env.DATABASE_URL);
const USER = "embed-test-user";

describe("deferred embedding", { skip: configured ? false : "DATABASE_URL not set" }, () => {
  after(async () => {
    await query(`DELETE FROM jobs WHERE dedupe_key LIKE 'embed:%' AND user_id IS NULL`);
    await query(`DELETE FROM facts WHERE user_id = $1`, [USER]);
    await query(`DELETE FROM conversations WHERE user_id = $1`, [USER]);
    await close();
  });

  it("writes a message without waiting for its embedding, and queues one", async () => {
    const conversationId = await createConversation(USER, "embed test");
    const id = await saveMessage(conversationId, USER, "user", "the sky is blue today");

    const [row] = await query<{ embedding: string | null }>(
      `SELECT embedding::text FROM messages WHERE id = $1`,
      [id],
    );
    assert.equal(row?.embedding, null, "the insert does not block on the embedding");

    const jobs = await query<{ status: string }>(
      `SELECT status FROM jobs WHERE dedupe_key = $1`,
      [`embed:messages:${id}`],
    );
    assert.equal(jobs.length, 1, "and a job was queued to fill it in");
  });

  it("fills the embedding in when the job runs, and is idempotent", async (t) => {
    if (!embeddingsConfigured()) return t.skip("no embeddings key configured");

    const conversationId = await createConversation(USER, "embed test");
    const id = await saveMessage(conversationId, USER, "assistant", "kathmandu is in nepal");

    assert.deepEqual(await embedRow("messages", id), { embedded: true });

    const [row] = await query<{ embedding: string | null }>(
      `SELECT embedding::text FROM messages WHERE id = $1`,
      [id],
    );
    assert.ok(row?.embedding, "the vector landed");

    // A duplicate job must not pay for a second embedding call.
    const again = await embedRow("messages", id);
    assert.equal(again.embedded, false);
    assert.match(again.reason ?? "", /already embedded/);
  });

  it("no-ops on a row that was deleted before its job ran", async () => {
    const conversationId = await createConversation(USER, "embed test");
    const id = await saveMessage(conversationId, USER, "user", "delete me");
    await query(`DELETE FROM messages WHERE id = $1`, [id]);

    const result = await embedRow("messages", id);
    assert.equal(result.embedded, false, "a missing row is not an error");
  });

  it("embeds facts through the same path", async () => {
    const id = await writeFact(USER, "prefers dark mode", "fact", "test");

    const [row] = await query<{ embedding: string | null }>(
      `SELECT embedding::text FROM facts WHERE id = $1`,
      [id],
    );
    assert.equal(row?.embedding, null);
    assert.equal(
      (await query(`SELECT 1 FROM jobs WHERE dedupe_key = $1`, [`embed:facts:${id}`])).length,
      1,
    );
  });

  it("backfills rows old enough that their job should have finished", async (t) => {
    if (!embeddingsConfigured()) return t.skip("no embeddings key configured");

    const id = await writeFact(USER, "backfill me", "fact", "test");
    // Age the row past the backfill window and drop its original job.
    await query(`UPDATE facts SET created_at = now() - interval '1 hour' WHERE id = $1`, [id]);
    await query(`DELETE FROM jobs WHERE dedupe_key = $1`, [`embed:facts:${id}`]);

    const { enqueued } = await backfillEmbeddings(50);
    assert.ok(enqueued >= 1);
    assert.equal(
      (await query(`SELECT 1 FROM jobs WHERE dedupe_key = $1`, [`embed:facts:${id}`])).length,
      1,
    );
  });
});
