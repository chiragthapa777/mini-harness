import { run } from "@mini-agent/agent";
import type { JobRegistry } from "@mini-agent/jobs";
import { enqueue } from "@mini-agent/jobs";
import {
  backfillEmbeddings,
  consolidate,
  conversationsNeedingSummary,
  createConversation,
  embedRow,
  summarizeConversation,
  titleFromFirstMessage,
  usersNeedingConsolidation,
} from "@mini-agent/memory";
import { logger } from "./logger.js";

/**
 * The dispatch table: job type -> what runs it. Handlers stay thin on purpose
 * — the behaviour lives in the packages, so the same code path serves a
 * scheduled run and a browser run.
 */
export const handlers: JobRegistry = {
  /** Fill in one row's embedding — the async half of every write to a vector table. */
  async embed_row({ table, id }) {
    return embedRow(table, id);
  },

  /**
   * Safety net: rows whose embed job was lost (worker killed before the retry
   * policy applied, or written while no worker was up) get re-enqueued.
   */
  async embed_backfill({ limit }) {
    return backfillEmbeddings(limit);
  },

  /**
   * Fold a conversation's new messages into its rolling summary, and upsert
   * the episodic event that summary becomes.
   */
  async summarize_conversation({ conversationId }) {
    return summarizeConversation(conversationId);
  },

  /**
   * The five-minute sweep. Only conversations with messages past their
   * watermark are enqueued, so an idle system does no model work at all.
   */
  async summarize_sweep({ limit }) {
    const due = await conversationsNeedingSummary(limit ?? 50);
    let enqueued = 0;

    for (const conversation of due) {
      const id = await enqueue(
        "summarize_conversation",
        { conversationId: conversation.id },
        { userId: conversation.user_id, dedupeKey: `summarize:${conversation.id}` },
      );
      if (id) enqueued++;
    }

    return { due: due.length, enqueued };
  },

  /**
   * Distil one user's unconsolidated messages into durable facts. The gate
   * inside `consolidate` means an under-quota user is a no-op, so this is safe
   * to enqueue speculatively.
   */
  async consolidate_user({ userId }) {
    return consolidate(userId);
  },

  /** Sweep: only users already past the batch gate are enqueued. */
  async consolidate_sweep({ limit }) {
    const due = await usersNeedingConsolidation(undefined, limit ?? 50);
    let enqueued = 0;

    for (const user of due) {
      const id = await enqueue(
        "consolidate_user",
        { userId: user.user_id },
        { userId: user.user_id, dedupeKey: `consolidate:${user.user_id}` },
      );
      if (id) enqueued++;
    }

    return { due: due.length, enqueued };
  },

  /**
   * A full agent run with nobody watching. It persists exactly like a chat
   * turn — same episodic write, same trace — so scheduled work shows up in the
   * conversation list and in LLM Ops without a second code path.
   */
  async agent_run({ userId, prompt, conversationId }) {
    if (!userId || !prompt) throw new Error("agent_run requires userId and prompt");

    const target = conversationId ?? (await createConversation(userId));
    await titleFromFirstMessage(target, prompt);

    const result = await run({ userId, conversationId: target, prompt });
    logger.info(`agent_run finished in ${result.trace.iterations} iteration(s)`);

    return {
      conversationId: target,
      // The admin panel uses this to get from a job straight to its run.
      traceId: result.traceId,
      stopReason: result.trace.stopReason,
      iterations: result.trace.iterations,
      replyPreview: result.reply.slice(0, 280),
    };
  },
};
