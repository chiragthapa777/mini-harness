import { getConfig } from "@mini-agent/config";
import { Router } from "express";
import { z } from "zod";
import { logger } from "../logger.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.middleware.js";
import { signToken, verifyPassword } from "../services/auth.service.js";
import {
  findUserByEmail,
  findUserById,
  recordFailedLogin,
  recordSuccessfulLogin,
} from "../services/users.service.js";
import { message } from "../utils/http.js";

export const authRoutes = Router();

const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8),
});

authRoutes.post("/auth/login", async (req, res) => {
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
    logger.error("login failed", err);
    res.status(500).json({ error: message(err) });
  }
});

authRoutes.get("/auth/me", requireAuth, async (req, res) => {
  const { userId } = req as AuthedRequest;
  const user = await findUserById(userId);
  if (!user) {
    res.status(401).json({ error: "user no longer exists" });
    return;
  }
  res.json({ id: user.id, email: user.email, role: user.role });
});
