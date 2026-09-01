import { run } from "@mini-agent/agent";
import type { JobRegistry } from "@mini-agent/jobs";
import { createConversation, titleFromFirstMessage } from "@mini-agent/memory";
import { logger } from "./logger.js";

/**
 * The dispatch table: job type -> what runs it. Handlers stay thin on purpose
 * — the behaviour lives in the packages, so the same code path serves a
 * scheduled run and a browser run.
 */
export const handlers: JobRegistry = {
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
      stopReason: result.trace.stopReason,
      iterations: result.trace.iterations,
      replyPreview: result.reply.slice(0, 280),
    };
  },
};
