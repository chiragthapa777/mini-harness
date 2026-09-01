import { getConfig } from "@mini-agent/config";
import { nextRun } from "./cron.js";
import { enqueue } from "./queue.js";
import { dueSchedules, hasLiveRun, markFired, seedSystemSchedules, type ScheduleRow } from "./schedules.js";
import type { JobPayloads, JobType } from "./types.js";
import type { WorkerLogger } from "./worker.js";

/**
 * The scheduler does one thing: turn a due schedule into a queued job. It
 * never runs anything itself, which is what keeps a slow job from delaying the
 * next tick, and means the retry/backoff/dead-letter policy is the same for
 * scheduled work as for everything else.
 */

export interface SchedulerOptions {
  tickIntervalMs?: number;
  logger?: WorkerLogger;
}

export interface Scheduler {
  stop(): void;
}

export function startScheduler(options: SchedulerOptions = {}): Scheduler {
  const log = options.logger ?? console;
  const intervalMs = options.tickIntervalMs ?? getConfig().jobs.schedulerTickMs;

  let running = false;

  const runTick = async () => {
    // A tick that overruns its interval must not stack up behind itself.
    if (running) return;
    running = true;
    try {
      const fired = await tick(log);
      if (fired > 0) log.info(`scheduler fired ${fired} schedule(s)`);
    } catch (err) {
      log.error("scheduler tick failed", err);
    } finally {
      running = false;
    }
  };

  const seeding = seedSystemSchedules()
    .then(() => log.info(`scheduler started — tick every ${intervalMs}ms`))
    .catch((err: unknown) => log.error("seeding system schedules failed", err));

  const timer = setInterval(() => void seeding.then(runTick), intervalMs);
  void seeding.then(runTick);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}

/** One pass over the due schedules. Exported so a test can drive it directly. */
export async function tick(log: WorkerLogger = console): Promise<number> {
  const due = await dueSchedules();
  let fired = 0;

  for (const schedule of due) {
    const next = nextRun(schedule.cron, new Date());

    // Overlap guard: the previous run is still queued or running, so skip this
    // firing entirely rather than piling a second one on top of it.
    if (await hasLiveRun(schedule)) {
      log.info(`schedule ${schedule.name} skipped — previous run still in flight`);
      await markFired(schedule.id, null, next);
      continue;
    }

    const jobId = await enqueue(schedule.job_type, payloadFor(schedule), {
      userId: schedule.user_id,
      // Belt and braces with the overlap guard above: two schedulers ticking at
      // once still produce one job.
      dedupeKey: `schedule:${schedule.id}`,
    });

    await markFired(schedule.id, jobId, next);
    if (jobId) fired++;
  }

  return fired;
}

/**
 * A user schedule is a prompt on a cadence, so its payload is built here; a
 * system schedule carries whatever config gave it (usually nothing — a sweep
 * finds its own work).
 */
function payloadFor(schedule: ScheduleRow): JobPayloads[JobType] {
  if (schedule.job_type === "agent_run") {
    return {
      userId: schedule.user_id ?? "",
      prompt: schedule.prompt ?? "",
      scheduleId: schedule.id,
    };
  }
  return schedule.payload as JobPayloads[JobType];
}
