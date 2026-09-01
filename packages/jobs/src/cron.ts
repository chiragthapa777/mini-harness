import { Cron } from "croner";

/**
 * Cron expression handling, in UTC. Two questions, which is all the scheduler
 * ever asks: "is this expression valid" and "when does it next fire".
 *
 *   ┌── minute (0-59)
 *   │ ┌── hour (0-23)
 *   │ │ ┌── day of month (1-31)
 *   │ │ │ ┌── month (1-12)
 *   │ │ │ │ ┌── day of week (0-6, Sunday = 0; 7 also accepted)
 *   * * * * *
 *
 * This wraps `croner` rather than parsing by hand. The module deliberately
 * exposes only the two functions above: croner's `Cron` is also a live
 * scheduler, and letting that leak into the codebase would invite in-process
 * timers to grow next to the queue. Firing is the database's job — a schedule
 * row with a `next_run_at`, polled by `scheduler.ts` — because that survives a
 * restart and stays correct with more than one worker running. What croner is
 * used for here is pure date arithmetic.
 *
 * Constructing a `Cron` with no callback schedules nothing; it just parses.
 * No `name` option either, since named jobs get pushed into croner's global
 * `scheduledJobs` registry and would never be collected.
 */

/**
 * `mode: "5-part"` pins the grammar to classic five-field cron. Croner also
 * accepts 6- and 7-field patterns (leading seconds, trailing year); allowing
 * those would let a user save `* * * * * *` and mean "every second", which the
 * queue would then interpret as "every scheduler tick". Five fields means the
 * finest schedule anyone can express is one a minute.
 *
 * `timezone: "UTC"` is not a default — croner resolves patterns in local time
 * unless told otherwise, and a schedule whose meaning moves with the server's
 * TZ (and with DST) is a bug waiting for the clocks to change.
 *
 * `sloppyRanges: true` keeps numeric-prefix stepping (`5/10` = 5, 15, 25, …)
 * working. Vixie cron accepts it and so did the parser this replaced, so
 * rejecting it now would quietly invalidate schedules already in the table.
 */
const OPTIONS = { mode: "5-part", timezone: "UTC", sloppyRanges: true } as const;

/** Throws on anything malformed — a schedule that never fires is worse than one that fails loudly. */
function compile(expression: string): Cron {
  return new Cron(expression.trim(), OPTIONS);
}

export function isValidCron(expression: string): boolean {
  try {
    // Parsing is not enough on its own: `0 0 30 2 *` is well-formed and simply
    // never happens, and accepting it would create a schedule that sits in the
    // table forever without firing.
    return compile(expression).nextRun() !== null;
  } catch {
    return false;
  }
}

/**
 * The first firing strictly after `from`, in UTC. Null when nothing matches —
 * an impossible date like `0 0 30 2 *` (30th of February), or a pattern whose
 * next run is past croner's horizon.
 */
export function nextRun(expression: string, from: Date = new Date()): Date | null {
  return compile(expression).nextRun(from);
}

/**
 * The next `count` firings, for previewing an expression before it is saved.
 * Croner walks the sequence itself, which is both faster and more obviously
 * correct than calling `nextRun` in a loop and feeding each result back in.
 */
export function nextRuns(expression: string, count: number, from: Date = new Date()): Date[] {
  return compile(expression).nextRuns(count, from);
}
