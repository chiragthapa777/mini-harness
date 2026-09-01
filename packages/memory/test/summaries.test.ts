import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { close, query } from "@mini-agent/db";
import { createConversation } from "../src/conversations.js";
import { saveMessage } from "../src/episodic.js";
import { conversationsNeedingSummary, summarizeConversation } from "../src/summaries.js";

/**
 * These hit a real model, so they need a chat provider as well as a database.
 * What is actually under test is the watermark and the event upsert — the
 * model call is a dependency, not the subject.
 */
const configured = Boolean(process.env.DATABASE_URL);
const hasModel = Boolean(process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY);
const USER = "summary-test-user";

describe("conversation summaries", { skip: configured ? false : "DATABASE_URL not set" }, () => {
  after(async () => {
    await query(`DELETE FROM conversations WHERE user_id = $1`, [USER]);
    await query(`DELETE FROM jobs WHERE dedupe_key LIKE 'embed:events:%'`);
    await close();
  });

  const seed = async () => {
    const id = await createConversation(USER, "trip planning");
    await saveMessage(id, USER, "user", "I am flying to Pokhara on the 12th of March for a week.");
    await saveMessage(id, USER, "assistant", "Noted — Pokhara, 12 March, one week. Want hotels?");
    await saveMessage(id, USER, "user", "Yes, somewhere near Phewa Lake, under 5000 rupees a night.");
    return id;
  };

  it("lists only conversations with messages past their watermark", async () => {
    const id = await seed();
    const due = await conversationsNeedingSummary(200);
    assert.ok(due.some((row) => row.id === id));

    // Move the watermark to the newest message; it should drop off the list.
    await query(
      `UPDATE conversations SET summary_message_id =
         (SELECT max(id) FROM messages WHERE conversation_id = $1) WHERE id = $1`,
      [id],
    );
    const after = await conversationsNeedingSummary(200);
    assert.equal(
      after.some((row) => row.id === id),
      false,
    );
  });

  it("writes a capped summary, moves the watermark, and upserts one event", async (t) => {
    if (!hasModel) return t.skip("no chat provider key configured");

    const id = await seed();
    const result = await summarizeConversation(id);

    assert.equal(result.skipped, undefined, `unexpected skip: ${result.skipped}`);
    assert.ok(result.words! <= 200, "the summary is capped at 200 words");
    assert.ok(result.eventId);

    const [conversation] = await query<{
      summary: string | null;
      summary_message_id: string | null;
      summary_updated_at: Date | null;
    }>(
      `SELECT summary, summary_message_id::text, summary_updated_at FROM conversations WHERE id = $1`,
      [id],
    );
    assert.ok(conversation?.summary, "the summary landed on the conversation");
    assert.ok(conversation?.summary_updated_at);

    const [latest] = await query<{ id: string }>(
      `SELECT max(id)::text AS id FROM messages WHERE conversation_id = $1`,
      [id],
    );
    assert.equal(conversation?.summary_message_id, latest?.id, "the watermark caught up");

    const events = await query<{ id: string; summary: string; occurred_at: Date }>(
      `SELECT id::text, summary, occurred_at FROM events WHERE conversation_id = $1`,
      [id],
    );
    assert.equal(events.length, 1, "one event per conversation");
    assert.equal(events[0]?.summary, conversation?.summary);

    // Nothing new since — the second pass must not call the model again.
    assert.equal((await summarizeConversation(id)).skipped, "already summarized");

    // A new message re-opens it, and the event is updated rather than duplicated.
    await saveMessage(id, USER, "user", "Actually make it the 15th, and add a paragliding day.");
    const second = await summarizeConversation(id);
    assert.equal(second.skipped, undefined);
    assert.equal(second.eventId, events[0]?.id, "the same event row was reused");

    const [event] = await query<{ embedding: string | null }>(
      `SELECT embedding::text FROM events WHERE conversation_id = $1`,
      [id],
    );
    assert.equal(event?.embedding, null, "a rewritten summary clears the stale vector");
  });

  it("skips a conversation that no longer exists", async () => {
    const result = await summarizeConversation("00000000-0000-0000-0000-000000000000");
    assert.equal(result.skipped, "conversation is gone");
  });
});
