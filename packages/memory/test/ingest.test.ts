import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { close, query } from "@mini-agent/db";
import { ingestDocument } from "../src/ingest.js";
import { searchFacts } from "../src/semantic.js";

const configured = Boolean(process.env.DATABASE_URL);
const USER = "ingest-test-user";

const DOC = [
  "# Deployment runbook",
  "",
  "The API is deployed from the main branch. Rollbacks are done by re-tagging the previous image.",
  "",
  "The worker must be drained before a database migration. Send SIGTERM and wait for the batch to finish.",
  "",
  "On-call rotates weekly on Mondays at 09:00 UTC.",
].join("\n");

describe("document ingest", { skip: configured ? false : "DATABASE_URL not set" }, () => {
  after(async () => {
    await query(`DELETE FROM facts WHERE user_id = $1`, [USER]);
    await close();
  });

  const clean = () => query(`DELETE FROM facts WHERE user_id = $1`, [USER]);

  it("stores each chunk with a traceable source and queues its embedding", async () => {
    await clean();
    const result = await ingestDocument(USER, "runbook.md", DOC, { maxChars: 120, overlapChars: 20 });

    assert.ok(result.chunks > 1, "a multi-paragraph document is split");
    assert.equal(result.factIds.length, result.chunks);

    const rows = await query<{ source: string; kind: string; embedding: string | null }>(
      `SELECT source, kind, embedding::text FROM facts WHERE user_id = $1 ORDER BY id`,
      [USER],
    );
    assert.equal(rows.length, result.chunks);
    assert.equal(rows[0]?.source, "file:runbook.md#0");
    assert.equal(rows[1]?.source, "file:runbook.md#1");
    assert.equal(rows[0]?.kind, "fact", "kind defaults through to writeFact");
    assert.equal(rows[0]?.embedding, null, "the request does not wait on embeddings");

    const queued = await query(
      `SELECT 1 FROM jobs WHERE dedupe_key = ANY($1::text[])`,
      [result.factIds.map((id) => `embed:facts:${id}`)],
    );
    assert.equal(queued.length, result.chunks, "one embed job per chunk");
  });

  it("re-uploading the same file does not double the memory", async () => {
    await clean();
    const first = await ingestDocument(USER, "runbook.md", DOC, { maxChars: 120, overlapChars: 20 });
    const second = await ingestDocument(USER, "runbook.md", DOC, { maxChars: 120, overlapChars: 20 });

    assert.deepEqual(second.factIds, first.factIds, "identical chunks land on the same rows");
    const [row] = await query<{ count: string }>(
      `SELECT count(*)::text FROM facts WHERE user_id = $1`,
      [USER],
    );
    assert.equal(Number(row?.count), first.chunks);
  });

  it("makes the uploaded text retrievable", async () => {
    await clean();
    await ingestDocument(USER, "runbook.md", DOC, { maxChars: 120, overlapChars: 20 });

    // The chunks have no vectors yet — their embed jobs are still queued — so
    // this exercises the ride-along path in searchFacts. Uploaded text has to
    // be reachable immediately, not once a worker gets to it.
    const facts = await searchFacts(USER, "how do I roll back", 10);
    assert.ok(facts.some((fact) => fact.content.includes("Rollbacks")));
  });

  it("refuses an empty file rather than storing nothing quietly", async () => {
    await assert.rejects(() => ingestDocument(USER, "empty.txt", "   \n\n "), /nothing to ingest/);
  });
});
