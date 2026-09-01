import {
  createSchedule,
  deleteSchedule,
  getSchedule,
  isValidCron,
  listSchedules,
  nextRun,
  updateSchedule,
} from "@mini-agent/jobs";
import { Router } from "express";
import { z } from "zod";
import { logger } from "../logger.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.middleware.js";
import { message } from "../utils/http.js";

export const schedulesRoutes = Router();

schedulesRoutes.use(requireAuth);

/**
 * A user schedule is a prompt on a cadence: the scheduler enqueues an
 * `agent_run` for it, the worker runs it, and the result lands in a
 * conversation like any other turn.
 *
 * Only `kind = 'user'` rows are reachable here — maintenance schedules are
 * config, and live in the admin panel.
 */
const cron = z.string().trim().refine(isValidCron, "not a valid 5-field cron expression");

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1),
  cron,
  enabled: z.boolean().optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  prompt: z.string().trim().min(1).optional(),
  cron: cron.optional(),
  enabled: z.boolean().optional(),
});

schedulesRoutes.get("/schedules", async (req, res) => {
  const { userId } = req as AuthedRequest;
  try {
    // A user's own schedules: the list is short by nature, so the first page
    // is the whole thing rather than another pager in the UI.
    const { schedules } = await listSchedules({ userId, kind: "user", limit: 200 });
    res.json(schedules);
  } catch (err) {
    logger.error("list schedules failed", err);
    res.status(500).json({ error: message(err) });
  }
});

/** Previews the next few firings so a cron expression can be sanity-checked before saving. */
schedulesRoutes.get("/schedules/preview", (req, res) => {
  const expression = typeof req.query.cron === "string" ? req.query.cron : "";
  if (!isValidCron(expression)) {
    res.status(400).json({ error: "not a valid 5-field cron expression" });
    return;
  }

  const runs: string[] = [];
  let cursor = new Date();
  for (let i = 0; i < 5; i++) {
    const next = nextRun(expression, cursor);
    if (!next) break;
    runs.push(next.toISOString());
    cursor = next;
  }
  res.json({ cron: expression, runs });
});

schedulesRoutes.post("/schedules", async (req, res) => {
  const { userId } = req as AuthedRequest;
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid schedule" });
    return;
  }

  try {
    res.status(201).json(await createSchedule({ userId, ...parsed.data }));
  } catch (err) {
    logger.error("create schedule failed", err);
    res.status(500).json({ error: message(err) });
  }
});

schedulesRoutes.patch("/schedules/:id", async (req, res) => {
  const { userId } = req as unknown as AuthedRequest;
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid schedule" });
    return;
  }

  const id = String(req.params.id);
  const existing = await getSchedule(id);
  // Same 404 for "not yours" as for "not there" — ownership is not discoverable.
  if (!existing || existing.user_id !== userId || existing.kind !== "user") {
    res.status(404).json({ error: "schedule not found" });
    return;
  }

  try {
    res.json(await updateSchedule(id, parsed.data));
  } catch (err) {
    logger.error("update schedule failed", err);
    res.status(400).json({ error: message(err) });
  }
});

schedulesRoutes.delete("/schedules/:id", async (req, res) => {
  const { userId } = req as unknown as AuthedRequest;
  const deleted = await deleteSchedule(String(req.params.id), userId);
  if (!deleted) {
    res.status(404).json({ error: "schedule not found" });
    return;
  }
  res.status(204).end();
});
