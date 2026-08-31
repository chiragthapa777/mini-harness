import express, { type Response } from "express";
import type { RunEvent } from "@mini-agent/core";
import {
  conversationMessages,
  createConversation,
  deleteConversation,
  listConversations,
  titleFromFirstMessage,
} from "./conversations.js";
import { run, runStream } from "./run.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// ------------------------------------------------------------ conversations

app.get("/conversations", async (req, res) => {
  const userId = String(req.query["userId"] ?? "local");
  res.json(await listConversations(userId));
});

app.post("/conversations", async (req, res) => {
  const { userId = "local", title } = req.body ?? {};
  res.json({ id: await createConversation(String(userId), title) });
});

app.get("/conversations/:id/messages", async (req, res) => {
  res.json(await conversationMessages(String(req.params.id)));
});

app.delete("/conversations/:id", async (req, res) => {
  const userId = String(req.query["userId"] ?? "local");
  await deleteConversation(String(req.params.id), userId);
  res.status(204).end();
});

// -------------------------------------------------------------------- chat

/** Non-streaming run. Unchanged — the original path stays as it was. */
app.post("/chat", async (req, res) => {
  const input = readChatInput(req.body);
  if (!input) {
    res.status(400).json({ error: "userId and prompt are required" });
    return;
  }

  try {
    const conversationId = input.conversationId ?? (await createConversation(input.userId));
    await titleFromFirstMessage(conversationId, input.prompt);
    const { reply, trace } = await run({ ...input, conversationId });
    res.json({ conversationId, reply, trace });
  } catch (err) {
    console.error("run failed", err);
    res.status(500).json({ error: message(err) });
  }
});

/**
 * Streaming run over SSE. Every harness event is forwarded as it happens:
 * thinking, per-iteration boundaries, tool calls and their results, text
 * deltas, guardrail trips, and the final trace.
 */
app.post("/chat/stream", async (req, res) => {
  const input = readChatInput(req.body);
  if (!input) {
    res.status(400).json({ error: "userId and prompt are required" });
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
    const conversationId = input.conversationId ?? (await createConversation(input.userId));
    await titleFromFirstMessage(conversationId, input.prompt);
    send(res, { type: "conversation", conversationId });

    for await (const event of runStream({ ...input, conversationId })) {
      if (aborted.value) break;
      send(res, event);
    }
  } catch (err) {
    console.error("stream failed", err);
    send(res, { type: "error", message: message(err) });
  } finally {
    send(res, { type: "done" });
    res.end();
  }
});

type OutboundEvent =
  | RunEvent
  | { type: "conversation"; conversationId: string }
  | { type: "done" };

function send(res: Response, event: OutboundEvent): void {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function readChatInput(body: unknown) {
  const { userId, conversationId, prompt } = (body ?? {}) as Record<string, unknown>;
  if (typeof prompt !== "string" || !prompt.trim()) return null;
  return {
    userId: typeof userId === "string" && userId ? userId : "local",
    conversationId: typeof conversationId === "string" ? conversationId : undefined,
    prompt,
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : "request failed";
}

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => {
  console.log(`api listening on http://localhost:${port}`);
});
