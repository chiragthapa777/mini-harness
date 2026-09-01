import express, { type Express } from "express";
import { adminRoutes } from "./routes/admin.routes.js";
import { authRoutes } from "./routes/auth.routes.js";
import { chatRoutes } from "./routes/chat.routes.js";
import { conversationsRoutes } from "./routes/conversations.routes.js";
import { healthRoutes } from "./routes/health.routes.js";

export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.use(healthRoutes);
  app.use(authRoutes);
  app.use(adminRoutes);
  app.use(conversationsRoutes);
  app.use(chatRoutes);

  return app;
}
