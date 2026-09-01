import { getConfig, type SystemSchedule } from "@mini-agent/config";
import { query } from "@mini-agent/db";
import { isValidCron, nextRun } from "./cron.js";
import type { JobType } from "./types.js";

/**
 * Schedules — the rows the scheduler turns into jobs.
 *
 * Two kinds, one table and one code path. `system` rows come from config and
 * are identified by a stable `key` so a restart updates them instead of
 * duplicating them; `user` rows are a prompt plus a cadence, created from the
 * API. Everything below is storage — the firing decision lives in `scheduler.ts`.
 */

export interface ScheduleRow {
  id: string;
  kind: "system" | "user";
  key: string | null;
  user_id: string | null;
  name: string;
  job_type: JobType;
  payload: Record<string, unknown>;
  prompt: string | null;
  cron: string;
  enabled: boolean;
  last_run_at: Date | null;
  last_job_id: string | null;
  next_run_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id::text, kind, key, user_id, name, job_type, payload, prompt, cron, enabled,
  last_run_at, last_job_id::text, next_run_at, created_at, updated_at`;

/**
 * Bring the config-defined schedules into the table. Idempotent, and
 * deliberately narrow on conflict: cron and name follow config, but `enabled`
 * does not — pausing a noisy maintenance job from the admin panel has to
 * survive the next deploy.
 */
export async function seedSystemSchedules(
  schedules: SystemSchedule[] = getConfig().schedules,
): Promise<void> {
  for (const schedule of schedules) {
    if (!isValidCron(schedule.cron)) {
      throw new Error(`system schedule "${schedule.key}" has an invalid cron: ${schedule.cron}`);
    }

    await query(
      `INSERT INTO scheduled_jobs (kind, key, name, job_type, cron, next_run_at)
       VALUES ('system', $1, $2, $3, $4, $5)
       ON CONFLICT (key) DO UPDATE
          SET name = EXCLUDED.name,
              job_type = EXCLUDED.job_type,
              cron = EXCLUDED.cron,
              -- a changed cadence needs a recomputed next firing; an unchanged
              -- one must keep the time it was already counting down to
              next_run_at = CASE WHEN scheduled_jobs.cron IS DISTINCT FROM EXCLUDED.cron
                                 THEN EXCLUDED.next_run_at
                                 ELSE scheduled_jobs.next_run_at END,
              updated_at = now()`,
      [schedule.key, schedule.name, schedule.jobType, schedule.cron, nextRun(schedule.cron)],
    );
  }
}

/** Enabled schedules whose next firing has arrived. */
export async function dueSchedules(limit = 50): Promise<ScheduleRow[]> {
  return query<ScheduleRow>(
    `SELECT ${COLUMNS} FROM scheduled_jobs
      WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= now()
      ORDER BY next_run_at
      LIMIT $1`,
    [limit],
  );
}

/** Records a firing: what it enqueued, and when it comes round again. */
export async function markFired(
  id: string,
  jobId: string | null,
  next: Date | null,
): Promise<void> {
  await query(
    `UPDATE scheduled_jobs
        SET last_run_at = CASE WHEN $2::bigint IS NULL THEN last_run_at ELSE now() END,
            last_job_id = coalesce($2::bigint, last_job_id),
            next_run_at = $3,
            updated_at = now()
      WHERE id = $1`,
    [id, jobId, next],
  );
}

/** True while the job this schedule last fired is still queued or running. */
export async function hasLiveRun(schedule: ScheduleRow): Promise<boolean> {
  if (!schedule.last_job_id) return false;
  const rows = await query<{ status: string }>(
    `SELECT status FROM jobs WHERE id = $1 AND status IN ('queued', 'running')`,
    [schedule.last_job_id],
  );
  return rows.length > 0;
}

// --------------------------------------------------------------------- CRUD

export interface CreateScheduleInput {
  userId: string;
  name: string;
  prompt: string;
  cron: string;
  enabled?: boolean;
}

/** A user schedule is always an `agent_run` — a prompt on a cadence. */
export async function createSchedule(input: CreateScheduleInput): Promise<ScheduleRow> {
  const next = nextRun(input.cron);
  if (!next) throw new Error(`cron expression never fires: ${input.cron}`);

  const [row] = await query<ScheduleRow>(
    `INSERT INTO scheduled_jobs (kind, user_id, name, job_type, prompt, cron, enabled, next_run_at)
     VALUES ('user', $1, $2, 'agent_run', $3, $4, $5, $6)
     RETURNING ${COLUMNS}`,
    [input.userId, input.name, input.prompt, input.cron, input.enabled ?? true, next],
  );
  if (!row) throw new Error("failed to create schedule");
  return row;
}

export async function listSchedules(
  filters: { userId?: string; kind?: "system" | "user" } = {},
): Promise<ScheduleRow[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filters.userId) {
    params.push(filters.userId);
    clauses.push(`user_id = $${params.length}`);
  }
  if (filters.kind) {
    params.push(filters.kind);
    clauses.push(`kind = $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  return query<ScheduleRow>(
    `SELECT ${COLUMNS} FROM scheduled_jobs ${where} ORDER BY kind, created_at DESC`,
    params,
  );
}

export async function getSchedule(id: string): Promise<ScheduleRow | undefined> {
  const [row] = await query<ScheduleRow>(`SELECT ${COLUMNS} FROM scheduled_jobs WHERE id = $1`, [
    id,
  ]);
  return row;
}

export interface UpdateScheduleInput {
  name?: string;
  prompt?: string;
  cron?: string;
  enabled?: boolean;
}

/**
 * A changed cadence recomputes the next firing; re-enabling a paused schedule
 * does too, so a schedule paused for a week does not fire a week of catch-up
 * runs the moment it comes back.
 */
export async function updateSchedule(
  id: string,
  patch: UpdateScheduleInput,
): Promise<ScheduleRow | undefined> {
  const existing = await getSchedule(id);
  if (!existing) return undefined;

  const cron = patch.cron ?? existing.cron;
  if (!isValidCron(cron)) throw new Error(`invalid cron expression: ${cron}`);

  const resumed = patch.enabled === true && !existing.enabled;
  const nextAt = patch.cron || resumed ? nextRun(cron) : existing.next_run_at;

  const [row] = await query<ScheduleRow>(
    `UPDATE scheduled_jobs
        SET name = $2, prompt = $3, cron = $4, enabled = $5, next_run_at = $6, updated_at = now()
      WHERE id = $1
      RETURNING ${COLUMNS}`,
    [
      id,
      patch.name ?? existing.name,
      patch.prompt ?? existing.prompt,
      cron,
      patch.enabled ?? existing.enabled,
      nextAt,
    ],
  );
  return row;
}

/** System schedules are config, not data — only user schedules can be deleted. */
export async function deleteSchedule(id: string, userId?: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `DELETE FROM scheduled_jobs
      WHERE id = $1 AND kind = 'user' ${userId ? "AND user_id = $2" : ""}
      RETURNING id::text`,
    userId ? [id, userId] : [id],
  );
  return rows.length > 0;
}
