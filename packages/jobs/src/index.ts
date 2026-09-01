import { getConfig } from "@mini-agent/config";

export {
  claim,
  enqueue,
  fail,
  getJob,
  jobStats,
  listJobs,
  reapStale,
  retryJob,
  succeed,
  type JobFilters,
} from "./queue.js";

export { runJob, startWorker, type Worker, type WorkerLogger, type WorkerOptions } from "./worker.js";

export {
  EMBEDDABLE_TABLES,
  JOB_TYPES,
  type EmbeddableTable,
  type EnqueueOptions,
  type JobHandler,
  type JobPayloads,
  type JobRecord,
  type JobRegistry,
  type JobStatus,
  type JobType,
} from "./types.js";

/**
 * Producers ask this before enqueueing. With no worker deployed
 * (`JOBS_ENABLED=false`) they fall back to doing the work inline, so the API
 * is never broken by the absence of a worker — only slower.
 */
export function jobsEnabled(): boolean {
  return getConfig().jobs.enabled;
}
