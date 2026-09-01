import { Router } from "express";
import { logger } from "../logger.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.middleware.js";
import { createConversation, titleFromFirstMessage } from "../services/conversations.service.js";
import { run, runStream } from "../services/run.service.js";
import { message } from "../utils/http.js";
import { sendEvent } from "../utils/sse.js";

export const chatRoutes = Router();

chatRoutes.use(requireAuth);

/** Non-streaming run. Unchanged — the original path stays as it was. */
chatRoutes.post("/chat", async (req, res) => {
  const { userId } = req as AuthedRequest;
  const input = readChatInput(req.body);
  if (!input) {
    res.status(400).json({ error: "prompt is required" });
    return;
  }

  try {
    const conversationId = input.conversationId ?? (await createConversation(userId));
    await titleFromFirstMessage(conversationId, input.prompt);
    const { reply, trace } = await run({ userId, conversationId, prompt: input.prompt });
    res.json({ conversationId, reply, trace });
  } catch (err) {
    logger.error("run failed", err);
    res.status(500).json({ error: message(err) });
  }
});

/**
 * Streaming run over SSE. Every harness event is forwarded as it happens:
 * thinking, per-iteration boundaries, tool calls and their results, text
 * deltas, guardrail trips, and the final trace.
 */
chatRoutes.post("/chat/stream", async (req, res) => {
  const { userId } = req as AuthedRequest;
  const input = readChatInput(req.body);
  if (!input) {
    res.status(400).json({ error: "prompt is required" });
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // Proxies that buffer will otherwise hold the whole stream to the end.
    "x-accel-buffering": "no",
  });

  // A client that navigates away should stop the run, not keep burning tokens.
  // This must listen on the response: `req` emits "close" as soon as the
  // request body has been read, which is immediately.
  const aborted = { value: false };
  res.on("close", () => {
    aborted.value = true;
  });

  try {
    const conversationId = input.conversationId ?? (await createConversation(userId));
    await titleFromFirstMessage(conversationId, input.prompt);
    sendEvent(res, { type: "conversation", conversationId });

    for await (const event of runStream({ userId, conversationId, prompt: input.prompt })) {
      if (aborted.value) break;
      sendEvent(res, event);
    }
  } catch (err) {
    logger.error("stream failed", err);
    sendEvent(res, { type: "error", message: message(err) });
  } finally {
    sendEvent(res, { type: "done" });
    res.end();
  }
});

function readChatInput(body: unknown) {
  const { conversationId, prompt } = (body ?? {}) as Record<string, unknown>;
  if (typeof prompt !== "string" || !prompt.trim()) return null;
  return {
    conversationId: typeof conversationId === "string" ? conversationId : undefined,
    prompt,
  };
}
