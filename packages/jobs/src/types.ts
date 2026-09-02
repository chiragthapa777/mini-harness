/**
 * The job contract.
 *
 * `JobPayloads` is deliberately a single map living in this package rather
 * than each producer inventing its own shape: the producer (api, memory) and
 * the consumer (the worker) never import each other, so the payload type is
 * the only thing that keeps them honest. This package owns the shape of the
 * work; the handlers own the behaviour.
 */

/** Tables carrying a `vector` column that a row-level embed job can fill in. */
export const EMBEDDABLE_TABLES = ["messages", "facts", "events"] as const;
export type EmbeddableTable = (typeof EMBEDDABLE_TABLES)[number];

export interface JobPayloads {
  /** Backfill one row's embedding — the async half of every write to a vector table. */
  embed_row: { table: EmbeddableTable; id: string };
  /** Sweep: re-enqueue rows whose embedding never landed. */
  embed_backfill: { limit?: number };
  /** Fold a conversation's new messages into its rolling summary + episodic event. */
  summarize_conversation: { conversationId: string };
  /** Sweep: find conversations with messages newer than their summary watermark. */
  summarize_sweep: { limit?: number };
  /** Distil one user's unconsolidated messages into semantic facts. */
  consolidate_user: { userId: string };
  /** Sweep: find users with enough unconsolidated messages to be worth a pass. */
  consolidate_sweep: { limit?: number };
  /** Merge near-duplicate facts for one user, archiving the losers. */
  dedupe_facts: { userId: string };
  /** Sweep: find users whose fact count justifies a dedup pass. */
  dedupe_sweep: { limit?: number };
  /** A full agent run with no browser attached — what a user's cron schedule fires. */
  agent_run: { userId: string; prompt: string; conversationId?: string; scheduleId?: string };
}

export type JobType = keyof JobPayloads;

export const JOB_TYPES = [
  "embed_row",
  "embed_backfill",
  "summarize_conversation",
  "summarize_sweep",
  "consolidate_user",
  "consolidate_sweep",
  "dedupe_facts",
  "dedupe_sweep",
  "agent_run",
] as const satisfies readonly JobType[];

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

/** One row of `jobs`. Column names, not camelCase — this is the row as stored. */
export interface JobRecord<T extends JobType = JobType> {
  id: string;
  type: T;
  user_id: string | null;
  payload: JobPayloads[T];
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  dedupe_key: string | null;
  result: unknown;
  scheduled_for: Date;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * A handler gets the typed payload and the row it came from. Whatever it
 * returns is stored on the job as `result`, which is what makes a finished job
 * readable in the admin panel instead of just "succeeded".
 */
export type JobHandler<T extends JobType> = (
  payload: JobPayloads[T],
  job: JobRecord<T>,
) => Promise<unknown>;

/** Partial: a worker may register only the handlers it is responsible for. */
export type JobRegistry = { [T in JobType]?: JobHandler<T> };

export interface EnqueueOptions {
  /** Attributes the job to a user. Null for maintenance work. */
  userId?: string | null;
  /** Earliest time the job may be claimed. Defaults to now. */
  scheduledFor?: Date;
  /** Only one live (queued or running) job may hold a given key. */
  dedupeKey?: string;
  maxAttempts?: number;
}
