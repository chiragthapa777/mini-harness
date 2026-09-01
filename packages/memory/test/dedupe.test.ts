import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { close, query } from "@mini-agent/db";
import { dedupeFacts, usersNeedingDedupe } from "../src/dedupe.js";
import { embeddingsConfigured, embedRow } from "../src/embeddings.js";
import { listFacts, searchFacts, writeFact } from "../src/semantic.js";

const configured = Boolean(process.env.DATABASE_URL);
const hasModel = Boolean(process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY);
const USER = "dedupe-test-user";

describe("fact consolidation", { skip: configured ? false : "DATABASE_URL not set" }, () => {
  after(async () => {
    await query(`DELETE FROM facts WHERE user_id = $1`, [USER]);
    await close();
  });

  const clean = () => query(`DELETE FROM facts WHERE user_id = $1`, [USER]);

  it("collapses an exact repeat into a touch instead of a new row", async () => {
    await clean();
    const first = await writeFact(USER, "Prefers Neovim", "fact", "agent");
    const second = await writeFact(USER, "  prefers neovim  ", "fact", "summarizer");

    assert.equal(second, first, "the same sentence is the same fact");
    const rows = await query<{ source: string; updated_at: Date; created_at: Date }>(
      `SELECT source, updated_at, created_at FROM facts WHERE user_id = $1`,
      [USER],
    );
    assert.equal(rows.length, 1);
    assert.ok(
      rows[0]!.updated_at.getTime() >= rows[0]!.created_at.getTime(),
      "seeing it again bumps updated_at",
    );
  });

  it("hides archived facts from retrieval but not from the admin listing", async () => {
    await clean();
    const kept = await writeFact(USER, "Lives in Kathmandu", "fact");
    const gone = await writeFact(USER, "Lived in Chitwan", "fact");
    await query(
      `UPDATE facts SET archived_at = now(), superseded_by = $2 WHERE id = $1`,
      [gone, kept],
    );

    const retrieved = await searchFacts(USER, "where do they live");
    assert.equal(
      retrieved.some((f) => f.id === gone),
      false,
      "a superseded fact never goes back in front of the model",
    );

    const active = await listFacts(USER);
    assert.equal(active.total, 1);

    const all = await listFacts(USER, { includeArchived: true });
    assert.equal(all.total, 2);
    assert.equal(all.facts.find((f) => f.id === gone)?.superseded_by, kept);
  });

  it("merges a near-duplicate cluster into its oldest row", async (t) => {
    if (!hasModel || !embeddingsConfigured()) return t.skip("needs a chat and embeddings key");
    await clean();

    const ids = [
      await writeFact(USER, "Chirag lives in Kathmandu, Nepal", "fact"),
      await writeFact(USER, "The user is based in Kathmandu", "fact"),
      await writeFact(USER, "Kathmandu is where the user lives", "fact"),
      await writeFact(USER, "The user's favourite editor is Neovim", "fact"),
    ];
    // The dedup pass works off embeddings, which normally land via a job.
    for (const id of ids) await embedRow("facts", id);

    const result = await dedupeFacts(USER);
    assert.equal(result.clusters, 1, "the three Kathmandu facts are one cluster");
    assert.equal(result.archived, 2);

    const active = await query<{ id: string; content: string }>(
      `SELECT id::text, content FROM facts WHERE user_id = $1 AND archived_at IS NULL ORDER BY id`,
      [USER],
    );
    assert.equal(active.length, 2, "one merged fact plus the unrelated one");
    assert.equal(active[0]?.id, ids[0], "the oldest row survives, so references hold");
    assert.match(active[0]!.content.toLowerCase(), /kathmandu/);

    const archived = await query<{ superseded_by: string }>(
      `SELECT superseded_by::text FROM facts WHERE user_id = $1 AND archived_at IS NOT NULL`,
      [USER],
    );
    assert.equal(archived.length, 2);
    assert.ok(archived.every((row) => row.superseded_by === ids[0]), "losers point at the survivor");

    // The merged text changed, so its vector must have been dropped and requeued.
    const [survivor] = await query<{ embedding: string | null }>(
      `SELECT embedding::text FROM facts WHERE id = $1`,
      [ids[0]],
    );
    assert.equal(survivor?.embedding, null);

    // A second pass over a clean set finds nothing to do.
    assert.equal((await dedupeFacts(USER)).clusters, 0);
  });

  it("lists only users with enough facts to bother", async () => {
    await clean();
    await writeFact(USER, "one", "fact");
    assert.equal(
      (await usersNeedingDedupe(5)).some((row) => row.user_id === USER),
      false,
    );
    assert.equal(
      (await usersNeedingDedupe(1)).some((row) => row.user_id === USER),
      true,
    );
  });
});
