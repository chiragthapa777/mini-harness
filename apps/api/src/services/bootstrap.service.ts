import { getConfig } from "@mini-agent/config";
import { logger } from "../logger.js";
import { hashPassword } from "./auth.service.js";
import { createUser, findUserByEmail } from "./users.service.js";

/**
 * With no public register route, the first admin has to come from somewhere.
 * Set ADMIN_EMAIL / ADMIN_PASSWORD and this runs once at startup; every call
 * after the account exists is a no-op, so the vars can stay set permanently.
 */
export async function ensureBootstrapAdmin(): Promise<void> {
  const { email, password } = getConfig().bootstrapAdmin;
  if (!email || !password) return;
  if (await findUserByEmail(email)) return;

  await createUser(email, await hashPassword(password), "admin");
  logger.info(`bootstrap admin created: ${email}`);
}
