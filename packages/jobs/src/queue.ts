import { getConfig } from "@mini-agent/config";
import { query } from "@mini-agent/db";
import type { EnqueueOptions, JobPayloads, JobRecord, JobStatus, JobType } from "./types.js";

/**
 * A Postgres-backed queue. No broker, no second datastore: `FOR UPDATE SKIP
 * LOCKED` is what makes N workers able to claim disjoint batches from one
 * table, and the same rows double as the audit log the admin panel reads.
 *
 * Nothing here knows what a job *does* — see `registry.ts` for that.
 */

const COLUMNS = `id::text, type, user_id, payload, status, attempts, max_attempts, last_error,
  dedupe_key, result, scheduled_for, started_at, finished_at, created_at, updated_at`;

/**
 * Enqueue work. Returns the new job id, or null when a live job already holds
 * the same `dedupeKey` — that is the normal path for sweeps, which re-enqueue
 * the same unit of work every tick until it is done.
 */
export async function enqueue<T extends JobType>(
  type: T,
  payload: JobPayloads[T],
  options: EnqueueOptions = {},
): Promise<string | null> {
  const [row] = await query<{ id: string }>(
    `INSERT INTO jobs (type, user_id, payload, dedupe_key, scheduled_for, max_attempts)
     VALUES ($1, $2, $3::jsonb, $4, coalesce($5, now()), $6)
     ON CONFLICT DO NOTHING
     RETURNING id::text`,
    [
      type,
      options.userId ?? null,
      JSON.stringify(payload),
      options.dedupeKey ?? null,
      options.scheduledFor ?? null,
      options.maxAttempts ?? getConfig().jobs.maxAttempts,
    ],
  );
  return row?.id ?? null;
}

/**
 * Claim up to `limit` due jobs for this worker, marking them running in the
 * same statement. `SKIP LOCKED` means a second worker walks past rows this one
 * has locked instead of blocking on them.
 */
export async function claim(limit: number, types?: readonly JobType[]): Promise<JobRecord[]> {
  const typeFilter = types?.length ? `AND type = ANY($2::text[])` : "";
  const params: unknown[] = types?.length ? [limit, types] : [limit];

  return query<JobRecord>(
    `UPDATE jobs
        SET status = 'running',
            attempts = attempts + 1,
            started_at = now(),
            updated_at = now()
      WHERE id IN (
        SELECT id FROM jobs
         WHERE status = 'queued' AND scheduled_for <= now() ${typeFilter}
         ORDER BY scheduled_for, id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING ${COLUMNS}`,
    params,
  );
}

export async function succeed(id: string, result?: unknown): Promise<void> {
  await query(
    `UPDATE jobs
        SET status = 'succeeded', result = $2::jsonb, last_error = NULL,
            finished_at = now(), updated_at = now()
      WHERE id = $1`,
    [id, result === undefined ? null : JSON.stringify(result)],
  );
}

/**
 * Retry with exponential backoff until `max_attempts`, then dead-letter.
 * A dead-lettered job stays in the table as `failed` — that is what makes it
 * visible (and retryable by hand) in the admin panel rather than silently gone.
 */
export async function fail(job: JobRecord, error: string): Promise<void> {
  const { retryBaseMs, retryMaxMs } = getConfig().jobs;
  const exhausted = job.attempts >= job.max_attempts;
  const delayMs = Math.min(retryMaxMs, retryBaseMs * 2 ** Math.max(0, job.attempts - 1));

  await query(
    `UPDATE jobs
        SET status = $2,
            last_error = $3,
            scheduled_for = CASE WHEN $2 = 'queued' THEN now() + ($4 || ' milliseconds')::interval
                                 ELSE scheduled_for END,
            finished_at = CASE WHEN $2 = 'failed' THEN now() ELSE NULL END,
            updated_at = now()
      WHERE id = $1`,
    [job.id, exhausted ? "failed" : "queued", error.slice(0, 4000), String(delayMs)],
  );
}

/**
 * A worker that dies mid-job leaves the row `running` forever. Anything that
 * has been running longer than the stale window goes back on the queue; the
 * attempt it already burned still counts, so a job that reliably kills its
 * worker eventually dead-letters instead of looping.
 */
export async function reapStale(staleAfterMs = getConfig().jobs.staleAfterMs): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE jobs
        SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
            last_error = 'worker died before finishing (stale claim reaped)',
            finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
            updated_at = now()
      WHERE status = 'running'
        AND started_at < now() - ($1 || ' milliseconds')::interval
      RETURNING id::text`,
    [String(staleAfterMs)],
  );
  return rows.length;
}

// ------------------------------------------------------------------- admin

export interface JobFilters {
  status?: JobStatus;
  type?: string;
  userId?: string;
  limit?: number;
  offset?: number;
}

export async function listJobs(
  filters: JobFilters = {},
): Promise<{ jobs: JobRecord[]; total: number }> {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filters.status) {
    params.push(filters.status);
    clauses.push(`status = $${params.length}`);
  }
  if (filters.type) {
    params.push(filters.type);
    clauses.push(`type = $${params.length}`);
  }
  if (filters.userId) {
    params.push(filters.userId);
    clauses.push(`user_id = $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const [jobs, countRows] = await Promise.all([
    query<JobRecord>(
      `SELECT ${COLUMNS} FROM jobs ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filters.limit ?? 50, filters.offset ?? 0],
    ),
    query<{ count: string }>(`SELECT count(*)::text FROM jobs ${where}`, params),
  ]);

  return { jobs, total: Number(countRows[0]?.count ?? 0) };
}

export async function getJob(id: string): Promise<JobRecord | undefined> {
  const [row] = await query<JobRecord>(`SELECT ${COLUMNS} FROM jobs WHERE id = $1`, [id]);
  return row;
}

/** Queue depth by status and type — the numbers the admin panel leads with. */
export async function jobStats(): Promise<{ status: JobStatus; type: string; count: number }[]> {
  return query<{ status: JobStatus; type: string; count: number }>(
    `SELECT status, type, count(*)::int AS count FROM jobs GROUP BY status, type ORDER BY type`,
  );
}

/**
 * Put a finished job back on the queue by hand. Attempts reset, so a failure
 * fixed by a config change gets the full retry budget again.
 */
export async function retryJob(id: string): Promise<JobRecord | undefined> {
  const [row] = await query<JobRecord>(
    `UPDATE jobs
        SET status = 'queued', attempts = 0, last_error = NULL,
            scheduled_for = now(), started_at = NULL, finished_at = NULL, updated_at = now()
      WHERE id = $1 AND status IN ('failed', 'succeeded')
      RETURNING ${COLUMNS}`,
    [id],
  );
  return row;
}
