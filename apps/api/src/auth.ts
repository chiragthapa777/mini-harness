import { getConfig } from "@mini-agent/config";
import type { NextFunction, Request, Response } from "express";
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import jwt from "jsonwebtoken";

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;

/** `scrypt` needs no extra dependency and is fine for password storage at this scale. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const derived = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  const expected = Buffer.from(hash, "hex");
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

interface TokenPayload {
  sub: string;
  email: string;
  role: "user" | "admin";
}

/** Thrown at call time, not import time, so a run that never touches auth never needs the var set. */
function jwtSecret(): string {
  const { jwtSecret: secret } = getConfig().api;
  if (!secret) throw new Error("JWT_SECRET is not set");
  return secret;
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, jwtSecret(), { expiresIn: getConfig().api.jwtExpiresIn as jwt.SignOptions["expiresIn"] });
}

/** Populated by `requireAuth`; handlers behind it can rely on all three fields being present. */
export interface AuthedRequest extends Request {
  userId: string;
  userEmail: string;
  userRole: "user" | "admin";
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
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

/** Mount after `requireAuth` — it reads `userRole`, which only `requireAuth` sets. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if ((req as AuthedRequest).userRole !== "admin") {
    res.status(403).json({ error: "admin access required" });
    return;
  }
  next();
}
