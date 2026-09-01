import { getConfig } from "@mini-agent/config";
import { close } from "@mini-agent/db";
import { startScheduler, startWorker } from "@mini-agent/jobs";
import { handlers } from "./handlers.js";
import { logger } from "./logger.js";

/**
 * The worker process. Everything the agent does outside a request lives here:
 * embeddings, summaries, consolidation, and scheduled runs.
 *
 * It shares the packages the API uses and adds no logic of its own — a second
 * entrypoint onto the same harness, not a second harness.
 */
const worker = startWorker({ registry: handlers, logger });

// The scheduler only enqueues; the loop above is what runs things. Splitting
// them means a long job never delays the next tick. Turn it off
// (SCHEDULER_ENABLED=false) on every worker but one if several are deployed.
const scheduler = getConfig().jobs.schedulerEnabled
  ? startScheduler({ logger })
  : { stop() {} };

let shuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received — finishing the current batch`);
    // Draining beats killing: a job interrupted mid-flight stays `running`
    // until the stale reaper picks it up, which delays it by the stale window.
    scheduler.stop();
    void worker
      .stop()
      .then(close)
      .then(() => process.exit(0));
  });
}
