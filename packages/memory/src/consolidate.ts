import { getConfig } from "@mini-agent/config";
import { query } from "@mini-agent/db";
import { markConsolidated, unconsolidated, type StoredMessage } from "./episodic.js";
import { FACT_EXTRACTION_PROMPT } from "./prompts.js";
import { writeFact } from "./semantic.js";
import { complete } from "./summarizer.js";

const AFTER_N_MESSAGES = getConfig().memory.consolidateAfterNMessages;

/** Distills raw messages into durable facts. A cheap model is enough. */
export type Summarizer = (messages: StoredMessage[]) => Promise<string[]>;

/**
 * The default `Summarizer`: one model call, one fact per line.
 *
 * Line-per-fact rather than JSON on purpose — there is no schema to get wrong,
 * a malformed line costs one fact instead of the whole batch, and the cheap
 * models this runs on are markedly better at it.
 */
export const extractFacts: Summarizer = async (messages) => {
  const transcript = messages
    .map((m) => `${m.created_at.toISOString()} ${m.role}: ${m.content}`)
    .join("\n");

  const response = await complete(FACT_EXTRACTION_PROMPT, transcript);

  return response
    .split("\n")
    .map((line) => line.replace(/^\s*[-*\d.)\s]+/, "").trim())
    .filter((line) => line.length > 3)
    // A model that decides there is nothing to keep tends to say so in a
    // sentence; that sentence must not be stored as a fact about the user.
    .filter((line) => !/^(none|nothing|no durable facts)\b/i.test(line));
};

/**
 * Episodic memory grows every run; semantic memory should not. The gate keeps
 * consolidation batched — after N new messages, not per turn — so the cost
 * stays bounded.
 *
 * Messages are marked consolidated only after their facts are written: a run
 * that dies half way leaves them pending and the next pass redoes the batch,
 * which is the cheaper failure than losing them silently.
 */
export async function consolidate(
  userId: string,
  summarize: Summarizer = extractFacts,
  afterN = AFTER_N_MESSAGES,
): Promise<{ consolidated: number; facts: number }> {
  const pending = await unconsolidated(userId);
  if (pending.length < afterN) return { consolidated: 0, facts: 0 };

  const facts = await summarize(pending);
  for (const fact of facts) {
    await writeFact(userId, fact, "fact", "summarizer");
  }

  await markConsolidated(pending.map((m) => m.id));
  return { consolidated: pending.length, facts: facts.length };
}

/**
 * Users with enough unconsolidated messages to be worth a pass. The `HAVING`
 * is the same gate `consolidate` applies, moved into SQL so the sweep enqueues
 * only work that will actually do something.
 */
export async function usersNeedingConsolidation(
  afterN = AFTER_N_MESSAGES,
  limit = 50,
): Promise<{ user_id: string; pending: number }[]> {
  return query<{ user_id: string; pending: number }>(
    `SELECT user_id, count(*)::int AS pending
       FROM messages
      WHERE consolidated_at IS NULL
      GROUP BY user_id
     HAVING count(*) >= $1
      ORDER BY count(*) DESC
      LIMIT $2`,
    [afterN, limit],
  );
}
