import { Router } from "express";
import { requireAuth, type AuthedRequest } from "../middleware/auth.middleware.js";
import {
  conversationMessages,
  createConversation,
  deleteConversation,
  listConversations,
} from "@mini-agent/memory";

export const conversationsRoutes = Router();

conversationsRoutes.use(requireAuth);

conversationsRoutes.get("/conversations", async (req, res) => {
  const { userId } = req as AuthedRequest;
  res.json(await listConversations(userId));
});

conversationsRoutes.post("/conversations", async (req, res) => {
  const { userId } = req as AuthedRequest;
  const { title } = (req.body ?? {}) as { title?: string };
  res.json({ id: await createConversation(userId, title) });
});

conversationsRoutes.get("/conversations/:id/messages", async (req, res) => {
  const { userId } = req as unknown as AuthedRequest;
  res.json(await conversationMessages(String(req.params.id), userId));
});

conversationsRoutes.delete("/conversations/:id", async (req, res) => {
  const { userId } = req as unknown as AuthedRequest;
  await deleteConversation(String(req.params.id), userId);
  res.status(204).end();
});
