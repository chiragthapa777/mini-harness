import { getConfig } from "@mini-agent/config";
import express, { type Response } from "express";
import { z } from "zod";
import type { RunEvent } from "@mini-agent/core";
import { hashPassword, requireAdmin, requireAuth, signToken, verifyPassword, type AuthedRequest } from "./auth.js";
import { ensureBootstrapAdmin } from "./bootstrap.js";
import {
  conversationMessages,
  createConversation,
  deleteConversation,
  listConversations,
  titleFromFirstMessage,
} from "./conversations.js";
import { run, runStream } from "./run.js";
import {
  createUser,
  findUserByEmail,
  findUserById,
  listUsers,
  recordFailedLogin,
  recordSuccessfulLogin,
} from "./users.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// ------------------------------------------------------------------- auth

const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8),
});

app.post("/auth/login", async (req, res) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "email and password are required" });
    return;
  }

  const { email, password } = parsed.data;
  try {
    const user = await findUserByEmail(email);
    if (!user) {
      res.status(401).json({ error: "invalid email or password" });
      return;
    }

    if (user.locked_until && user.locked_until.getTime() > Date.now()) {
      res.status(423).json({
        error: `account locked due to repeated failed logins, try again after ${user.locked_until.toISOString()}`,
      });
      return;
    }

    if (!(await verifyPassword(password, user.password_hash))) {
      const { maxLoginAttempts, lockoutMinutes } = getConfig().auth;
      await recordFailedLogin(user.id, maxLoginAttempts, lockoutMinutes);
      res.status(401).json({ error: "invalid email or password" });
      return;
    }

    await recordSuccessfulLogin(user.id);
    const token = signToken({ sub: user.id, email: user.email, role: user.role });
    res.json({ token, user: { id: user.id, email: user.email, role: user.role } });
  } catch (err) {
    console.error("login failed", err);
    res.status(500).json({ error: message(err) });
  }
});

app.get("/auth/me", requireAuth, async (req, res) => {
  const { userId } = req as AuthedRequest;
  const user = await findUserById(userId);
  if (!user) {
    res.status(401).json({ error: "user no longer exists" });
    return;
  }
  res.json({ id: user.id, email: user.email, role: user.role });
});

// ------------------------------------------------------------------ admin

const adminCreateUserSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8),
  role: z.enum(["user", "admin"]).default("user"),
});

/** No self-registration: accounts are provisioned by an admin (or the startup bootstrap). */
app.get("/admin/users", requireAuth, requireAdmin, async (_req, res) => {
  res.json(await listUsers());
});

app.post("/admin/users", requireAuth, requireAdmin, async (req, res) => {
  const parsed = adminCreateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "a valid email, a password of at least 8 characters, and an optional role are required",
    });
    return;
  }

  const { email, password, role } = parsed.data;
  try {
    if (await findUserByEmail(email)) {
      res.status(409).json({ error: "an account with this email already exists" });
      return;
    }
    const user = await createUser(email, await hashPassword(password), role);
    res.status(201).json({ id: user.id, email: user.email, role: user.role });
  } catch (err) {
    console.error("admin create user failed", err);
    res.status(500).json({ error: message(err) });
  }
});

// ------------------------------------------------------------ conversations

app.get("/conversations", requireAuth, async (req, res) => {
  const { userId } = req as AuthedRequest;
  res.json(await listConversations(userId));
});

app.post("/conversations", requireAuth, async (req, res) => {
  const { userId } = req as AuthedRequest;
  const { title } = (req.body ?? {}) as { title?: string };
  res.json({ id: await createConversation(userId, title) });
});

app.get("/conversations/:id/messages", requireAuth, async (req, res) => {
  const { userId } = req as AuthedRequest;
  res.json(await conversationMessages(String(req.params.id), userId));
});

app.delete("/conversations/:id", requireAuth, async (req, res) => {
  const { userId } = req as AuthedRequest;
  await deleteConversation(String(req.params.id), userId);
  res.status(204).end();
});

// -------------------------------------------------------------------- chat

/** Non-streaming run. Unchanged — the original path stays as it was. */
app.post("/chat", requireAuth, async (req, res) => {
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
    console.error("run failed", err);
    res.status(500).json({ error: message(err) });
  }
});

/**
 * Streaming run over SSE. Every harness event is forwarded as it happens:
 * thinking, per-iteration boundaries, tool calls and their results, text
 * deltas, guardrail trips, and the final trace.
 */
app.post("/chat/stream", requireAuth, async (req, res) => {
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
    send(res, { type: "conversation", conversationId });

    for await (const event of runStream({ userId, conversationId, prompt: input.prompt })) {
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
  const { conversationId, prompt } = (body ?? {}) as Record<string, unknown>;
  if (typeof prompt !== "string" || !prompt.trim()) return null;
  return {
    conversationId: typeof conversationId === "string" ? conversationId : undefined,
    prompt,
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : "request failed";
}

const port = getConfig().api.port;
await ensureBootstrapAdmin();
app.listen(port, () => {
  console.log(`api listening on http://localhost:${port}`);
});
