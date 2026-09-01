import { getJob, jobStats, listJobs, retryJob } from "@mini-agent/jobs";
import { listFacts } from "@mini-agent/memory";
import { Router } from "express";
import { z } from "zod";
import { logger } from "../logger.js";
import { requireAdmin, requireAuth } from "../middleware/auth.middleware.js";
import { hashPassword } from "../services/auth.service.js";
import { getTrace, listTraces } from "../services/traces.service.js";
import {
  createUser,
  findUserByEmail,
  findUserById,
  listUsers,
  setUserRole,
  unlockUser,
} from "../services/users.service.js";
import { clampInt, message, parseDate } from "../utils/http.js";

export const adminRoutes = Router();

/** Every route below is admin-only. */
adminRoutes.use(requireAuth, requireAdmin);

// ------------------------------------------------------------------- users

const adminCreateUserSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8),
  role: z.enum(["user", "admin"]).default("user"),
});

/** No self-registration: accounts are provisioned by an admin (or the startup bootstrap). */
adminRoutes.get("/admin/users", async (_req, res) => {
  res.json(await listUsers());
});

adminRoutes.post("/admin/users", async (req, res) => {
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
    logger.error("admin create user failed", err);
    res.status(500).json({ error: message(err) });
  }
});

const adminUpdateUserSchema = z.object({
  role: z.enum(["user", "admin"]).optional(),
  unlock: z.boolean().optional(),
});

/** Role changes and lockout clears — the two controls an admin needs over an existing account. */
adminRoutes.patch("/admin/users/:id", async (req, res) => {
  const parsed = adminUpdateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "role must be 'user' or 'admin', unlock must be a boolean" });
    return;
  }

  const id = String(req.params.id);
  if (!(await findUserById(id))) {
    res.status(404).json({ error: "user not found" });
    return;
  }

  try {
    const { role, unlock } = parsed.data;
    if (role) await setUserRole(id, role);
    if (unlock) await unlockUser(id);
    const updated = await findUserById(id);
    res.json({ id: updated?.id, email: updated?.email, role: updated?.role });
  } catch (err) {
    logger.error("admin update user failed", err);
    res.status(500).json({ error: message(err) });
  }
});

// ------------------------------------------------------------------- facts

// Memory — a user's semantic facts, admin-viewable for any user.
adminRoutes.get("/admin/facts", async (req, res) => {
  const userId = typeof req.query.userId === "string" ? req.query.userId : undefined;
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
  const limit = clampInt(req.query.limit, 20, 1, 100);
  const offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);

  try {
    res.json(await listFacts(userId, { kind, limit, offset }));
  } catch (err) {
    logger.error("admin list facts failed", err);
    res.status(500).json({ error: message(err) });
  }
});

// ------------------------------------------------------------------ traces

// Traces — LLM Ops: filter by user, model, error status, and date range.
adminRoutes.get("/admin/traces", async (req, res) => {
  const q = req.query;
  try {
    res.json(
      await listTraces({
        userId: typeof q.userId === "string" && q.userId ? q.userId : undefined,
        model: typeof q.model === "string" && q.model ? q.model : undefined,
        errorOnly: q.errorOnly === "true",
        from: parseDate(q.from),
        to: parseDate(q.to),
        limit: clampInt(q.limit, 50, 1, 200),
        offset: clampInt(q.offset, 0, 0, Number.MAX_SAFE_INTEGER),
      }),
    );
  } catch (err) {
    logger.error("admin list traces failed", err);
    res.status(500).json({ error: message(err) });
  }
});

adminRoutes.get("/admin/traces/:id", async (req, res) => {
  const trace = await getTrace(String(req.params.id));
  if (!trace) {
    res.status(404).json({ error: "trace not found" });
    return;
  }
  res.json(trace);
});

// -------------------------------------------------------------------- jobs

const JOB_STATUSES = ["queued", "running", "succeeded", "failed"] as const;

/** Queue depth by status and type — read before the listing, so it stays cheap. */
adminRoutes.get("/admin/jobs/stats", async (_req, res) => {
  try {
    res.json(await jobStats());
  } catch (err) {
    logger.error("admin job stats failed", err);
    res.status(500).json({ error: message(err) });
  }
});

// Background work — the same rows the worker claims from, read-only here.
adminRoutes.get("/admin/jobs", async (req, res) => {
  const q = req.query;
  const status = JOB_STATUSES.find((s) => s === q.status);

  try {
    res.json(
      await listJobs({
        status,
        type: typeof q.type === "string" && q.type ? q.type : undefined,
        userId: typeof q.userId === "string" && q.userId ? q.userId : undefined,
        limit: clampInt(q.limit, 50, 1, 200),
        offset: clampInt(q.offset, 0, 0, Number.MAX_SAFE_INTEGER),
      }),
    );
  } catch (err) {
    logger.error("admin list jobs failed", err);
    res.status(500).json({ error: message(err) });
  }
});

adminRoutes.get("/admin/jobs/:id", async (req, res) => {
  const job = await getJob(String(req.params.id));
  if (!job) {
    res.status(404).json({ error: "job not found" });
    return;
  }
  res.json(job);
});

/**
 * Requeue a finished job by hand — the fix for a dead-lettered job once
 * whatever broke it (a missing key, a provider outage) has been sorted out.
 * Attempts reset, so it gets the full retry budget again.
 */
adminRoutes.post("/admin/jobs/:id/retry", async (req, res) => {
  try {
    const job = await retryJob(String(req.params.id));
    if (!job) {
      res.status(409).json({ error: "only a finished job can be retried" });
      return;
    }
    res.json(job);
  } catch (err) {
    logger.error("admin retry job failed", err);
    res.status(500).json({ error: message(err) });
  }
});
