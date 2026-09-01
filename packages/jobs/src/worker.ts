import { getConfig } from "@mini-agent/config";
import { claim, fail, reapStale, succeed } from "./queue.js";
import type { JobHandler, JobRecord, JobRegistry, JobType } from "./types.js";

export interface WorkerLogger {
  info(message: string): void;
  error(message: string, err?: unknown): void;
}

export interface WorkerOptions {
  registry: JobRegistry;
  /** Restrict this worker to a subset of job types. Defaults to everything registered. */
  types?: readonly JobType[];
  pollIntervalMs?: number;
  batchSize?: number;
  logger?: WorkerLogger;
}

export interface Worker {
  /** Resolves once the current batch has drained. */
  stop(): Promise<void>;
}

/**
 * Claim → run → mark. One batch at a time, sleeping only when the queue is
 * empty, so a backlog drains at full speed but an idle worker costs one query
 * per poll interval.
 *
 * A handler that throws is not fatal: the failure is recorded on the job and
 * the loop continues. That is the whole point of the queue — one poisonous
 * payload must not take the worker down with it.
 */
export function startWorker(options: WorkerOptions): Worker {
  const { jobs: config } = getConfig();
  const log = options.logger ?? console;
  const pollIntervalMs = options.pollIntervalMs ?? config.pollIntervalMs;
  const batchSize = options.batchSize ?? config.batchSize;
  const types = options.types ?? (Object.keys(options.registry) as JobType[]);

  let stopping = false;
  let lastReapAt = 0;

  const loop = (async () => {
    log.info(`worker started — types: ${types.join(", ") || "(none)"}`);

    while (!stopping) {
      try {
        // Reap on the same cadence as the stale window, not every poll.
        if (Date.now() - lastReapAt > config.staleAfterMs) {
          lastReapAt = Date.now();
          const reaped = await reapStale();
          if (reaped) log.info(`reaped ${reaped} stale job(s)`);
        }

        const batch = await claim(batchSize, types);
        if (batch.length === 0) {
          await sleep(pollIntervalMs, () => stopping);
          continue;
        }

        await Promise.all(batch.map((job) => runJob(job, options.registry, log)));
      } catch (err) {
        // Claiming itself failed — almost always the database being away.
        log.error("worker poll failed", err);
        await sleep(pollIntervalMs, () => stopping);
      }
    }

    log.info("worker stopped");
  })();

  return {
    async stop() {
      stopping = true;
      await loop;
    },
  };
}

/**
 * Run one claimed job to a terminal state. Exported so a caller can execute a
 * job inline — tests, and the "run it now" path — without a polling worker.
 */
export async function runJob(
  job: JobRecord,
  registry: JobRegistry,
  log: WorkerLogger = console,
): Promise<void> {
  const handler = registry[job.type] as JobHandler<JobType> | undefined;

  if (!handler) {
    await fail(job, `no handler registered for job type: ${job.type}`);
    return;
  }

  const startedAt = Date.now();
  try {
    const result = await handler(job.payload, job);
    await succeed(job.id, result);
    log.info(`job ${job.id} ${job.type} succeeded in ${Date.now() - startedAt}ms`);
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    await fail(job, messageText);
    log.error(`job ${job.id} ${job.type} failed (attempt ${job.attempts}): ${messageText}`);
  }
}

/** Interruptible sleep — a stopping worker should not sit out a full poll interval. */
async function sleep(ms: number, cancelled: () => boolean): Promise<void> {
  const step = Math.min(ms, 250);
  for (let waited = 0; waited < ms; waited += step) {
    if (cancelled()) return;
    await new Promise((resolve) => setTimeout(resolve, step));
  }
}
