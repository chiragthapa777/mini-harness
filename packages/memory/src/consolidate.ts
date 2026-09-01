import { getConfig } from "@mini-agent/config";
import { markConsolidated, unconsolidated, type StoredMessage } from "./episodic.js";
import { writeFact } from "./semantic.js";

const AFTER_N_MESSAGES = getConfig().memory.consolidateAfterNMessages;

/** Distills raw messages into durable facts. A cheap model is enough. */
export type Summarizer = (messages: StoredMessage[]) => Promise<string[]>;

/**
 * Episodic memory grows every run; semantic memory should not. The gate keeps
 * consolidation batched — after N new messages, not per turn — so the cost
 * stays bounded.
 */
export async function consolidate(
  userId: string,
  summarize: Summarizer,
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
