import type { NextFunction, Request, RequestHandler, Response } from "express";
import jwt from "jsonwebtoken";
import { jwtSecret, type TokenPayload } from "../services/auth.service.js";
import { findUserById } from "../services/users.service.js";

/** Populated by `requireAuth`; handlers behind it can rely on all three fields being present. */
export interface AuthedRequest extends Request {
  userId: string;
  userEmail: string;
  userRole: "user" | "admin";
}

export function verifyToken(req: Request, res: Response, next: NextFunction): void {
  const header = req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  if (!token) {
    res.status(401).json({ error: "missing bearer token" });
    return;
  }

  try {
    const payload = jwt.verify(token, jwtSecret()) as TokenPayload;
    (req as AuthedRequest).userId = payload.sub;
    (req as AuthedRequest).userEmail = payload.email;
    (req as AuthedRequest).userRole = payload.role;
    next();
  } catch {
    res.status(401).json({ error: "invalid or expired token" });
  }
}

/**
 * The token only proves who the caller was at login. Role and block state are
 * read from the database on every request, so a demotion or a block takes
 * effect immediately instead of when the token expires.
 */
export async function loadCurrentUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await findUserById((req as AuthedRequest).userId);
    if (!user) {
      res.status(401).json({ error: "user no longer exists" });
      return;
    }
    if (user.blocked) {
      res.status(403).json({ error: "account blocked" });
      return;
    }
    (req as AuthedRequest).userRole = user.role;
    next();
  } catch (err) {
    next(err);
  }
}

export const requireAuth: RequestHandler[] = [verifyToken, loadCurrentUser];

/** Mount after `requireAuth` — it reads `userRole`, which only `requireAuth` sets. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if ((req as AuthedRequest).userRole !== "admin") {
    res.status(403).json({ error: "admin access required" });
    return;
  }
  next();
}
