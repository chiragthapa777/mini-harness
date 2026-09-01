import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { close, query } from "@mini-agent/db";
import { consolidate, extractFacts, usersNeedingConsolidation } from "../src/consolidate.js";
import { createConversation } from "../src/conversations.js";
import { saveMessage } from "../src/episodic.js";

const configured = Boolean(process.env.DATABASE_URL);
const hasModel = Boolean(process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY);
const USER = "consolidate-test-user";

describe("consolidation", { skip: configured ? false : "DATABASE_URL not set" }, () => {
  after(async () => {
    await query(`DELETE FROM facts WHERE user_id = $1`, [USER]);
    await query(`DELETE FROM conversations WHERE user_id = $1`, [USER]);
    await close();
  });

  const seed = async (count: number) => {
    const id = await createConversation(USER, "consolidation");
    for (let i = 0; i < count; i++) {
      await saveMessage(id, USER, i % 2 === 0 ? "user" : "assistant", `message ${i}`);
    }
    return id;
  };

  const clean = async () => {
    await query(`DELETE FROM facts WHERE user_id = $1`, [USER]);
    await query(`DELETE FROM conversations WHERE user_id = $1`, [USER]);
  };

  it("does nothing until the batch gate is met", async () => {
    await clean();
    await seed(3);

    const result = await consolidate(USER, async () => ["never called"], 10);
    assert.deepEqual(result, { consolidated: 0, facts: 0 });
    assert.equal((await query(`SELECT 1 FROM facts WHERE user_id = $1`, [USER])).length, 0);
  });

  it("writes facts and marks the batch consolidated", async () => {
    await clean();
    await seed(4);

    const result = await consolidate(USER, async () => ["lives in Kathmandu", "prefers Neovim"], 4);
    assert.equal(result.consolidated, 4);
    assert.equal(result.facts, 2);

    const facts = await query<{ content: string; source: string }>(
      `SELECT content, source FROM facts WHERE user_id = $1 ORDER BY id`,
      [USER],
    );
    assert.deepEqual(
      facts.map((f) => f.content),
      ["lives in Kathmandu", "prefers Neovim"],
    );
    assert.equal(facts[0]?.source, "summarizer");

    const pending = await query(
      `SELECT 1 FROM messages WHERE user_id = $1 AND consolidated_at IS NULL`,
      [USER],
    );
    assert.equal(pending.length, 0, "the batch is not offered again");

    // Nothing left pending, so a second pass is a no-op.
    assert.deepEqual(await consolidate(USER, async () => ["nope"], 1), {
      consolidated: 0,
      facts: 0,
    });
  });

  it("lists only users already past the gate", async () => {
    await clean();
    await seed(2);

    assert.equal(
      (await usersNeedingConsolidation(10)).some((row) => row.user_id === USER),
      false,
    );
    const due = await usersNeedingConsolidation(2);
    assert.equal(due.find((row) => row.user_id === USER)?.pending, 2);
  });

  it("extracts self-contained facts from a transcript", async (t) => {
    if (!hasModel) return t.skip("no chat provider key configured");
    await clean();

    const conversationId = await createConversation(USER, "facts");
    await saveMessage(conversationId, USER, "user", "I moved to Pokhara last month for a new job at Fusemachines.");
    await saveMessage(conversationId, USER, "assistant", "Congratulations on the move.");
    await saveMessage(conversationId, USER, "user", "Always reply in metric units, I never use miles.");

    const messages = await query<{ id: string; role: "user"; content: string; created_at: Date }>(
      `SELECT id::text, role, content #>> '{}' AS content, created_at
         FROM messages WHERE conversation_id = $1 ORDER BY id`,
      [conversationId],
    );

    const facts = await extractFacts(messages);
    assert.ok(facts.length >= 1, "something durable was found");
    // The prompt asks for one short fact per line, stripped of list markers.
    for (const fact of facts) {
      assert.equal(fact.includes("\n"), false);
      assert.equal(/^[-*\d]/.test(fact), false, `list marker survived: ${fact}`);
    }
    assert.match(facts.join(" ").toLowerCase(), /pokhara|metric|fusemachines/);
  });
});
