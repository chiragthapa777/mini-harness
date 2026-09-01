import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { close, query } from "@mini-agent/db";
import { listJobs } from "../src/queue.js";
import { tick } from "../src/scheduler.js";
import {
  createSchedule,
  deleteSchedule,
  getSchedule,
  seedSystemSchedules,
  updateSchedule,
} from "../src/schedules.js";

/** Same policy as the queue suite: real Postgres or nothing. */
const configured = Boolean(process.env.DATABASE_URL);
const USER = "scheduler-test-user";
const silent = { info() {}, error() {} };

/** Pull a schedule's next firing into the past so a tick sees it as due. */
const makeDue = (id: string) =>
  query(`UPDATE scheduled_jobs SET next_run_at = now() - interval '1 minute' WHERE id = $1`, [id]);

describe("scheduler", { skip: configured ? false : "DATABASE_URL not set" }, () => {
  const clean = async () => {
    await query(`DELETE FROM jobs WHERE user_id = $1`, [USER]);
    await query(`DELETE FROM scheduled_jobs WHERE user_id = $1`, [USER]);
  };

  after(async () => {
    await clean();
    await close();
  });

  it("seeds system schedules idempotently and keeps a pause across restarts", async () => {
    const schedules = [
      { key: "test-sweep", name: "Test sweep", jobType: "embed_backfill", cron: "*/5 * * * *" },
    ];
    await seedSystemSchedules(schedules);
    const [first] = await query<{ id: string; enabled: boolean }>(
      `SELECT id::text, enabled FROM scheduled_jobs WHERE key = 'test-sweep'`,
    );
    assert.ok(first);

    // An admin pauses it, then the process restarts and seeds again.
    await query(`UPDATE scheduled_jobs SET enabled = false WHERE key = 'test-sweep'`);
    await seedSystemSchedules(schedules);

    const rows = await query<{ id: string; enabled: boolean }>(
      `SELECT id::text, enabled FROM scheduled_jobs WHERE key = 'test-sweep'`,
    );
    assert.equal(rows.length, 1, "seeding twice does not duplicate");
    assert.equal(rows[0]?.enabled, false, "seeding never re-enables what an admin paused");

    await query(`DELETE FROM scheduled_jobs WHERE key = 'test-sweep'`);
  });

  it("turns a due user schedule into an agent_run job", async () => {
    await clean();
    const schedule = await createSchedule({
      userId: USER,
      name: "Morning briefing",
      prompt: "What is on my plate today?",
      cron: "0 9 * * *",
    });
    assert.ok(schedule.next_run_at, "a new schedule knows when it fires next");

    await makeDue(schedule.id);
    assert.equal(await tick(silent), 1);

    const { jobs } = await listJobs({ userId: USER });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.type, "agent_run");
    assert.deepEqual(jobs[0]?.payload, {
      userId: USER,
      prompt: "What is on my plate today?",
      scheduleId: schedule.id,
    });

    const after = await getSchedule(schedule.id);
    assert.ok(after?.last_run_at, "the firing is recorded");
    assert.equal(after?.last_job_id, jobs[0]?.id);
    assert.ok(after!.next_run_at!.getTime() > Date.now(), "and the schedule moves on");
  });

  it("does not fire on top of a run that is still in flight", async () => {
    await clean();
    const schedule = await createSchedule({
      userId: USER,
      name: "Slow job",
      prompt: "take your time",
      cron: "*/5 * * * *",
    });

    await makeDue(schedule.id);
    await tick(silent);

    // The first job is still queued; the next firing must skip, not stack.
    await makeDue(schedule.id);
    assert.equal(await tick(silent), 0, "skipped while the previous run is live");
    assert.equal((await listJobs({ userId: USER })).total, 1);

    // Once it finishes, the schedule fires again.
    await query(`UPDATE jobs SET status = 'succeeded' WHERE user_id = $1`, [USER]);
    await makeDue(schedule.id);
    assert.equal(await tick(silent), 1);
    assert.equal((await listJobs({ userId: USER })).total, 2);
  });

  it("skips a paused schedule and reschedules from now when resumed", async () => {
    await clean();
    const schedule = await createSchedule({
      userId: USER,
      name: "Paused",
      prompt: "nope",
      cron: "*/5 * * * *",
    });

    await updateSchedule(schedule.id, { enabled: false });
    await makeDue(schedule.id);
    assert.equal(await tick(silent), 0);
    assert.equal((await listJobs({ userId: USER })).total, 0);

    // Resuming must not fire a backlog: the next run is computed from now.
    const resumed = await updateSchedule(schedule.id, { enabled: true });
    assert.ok(resumed!.next_run_at!.getTime() > Date.now());
  });

  it("only deletes user schedules, and only their owner's", async () => {
    await clean();
    const schedule = await createSchedule({
      userId: USER,
      name: "Mine",
      prompt: "hello",
      cron: "0 * * * *",
    });

    assert.equal(await deleteSchedule(schedule.id, "somebody-else"), false);
    assert.equal(await deleteSchedule(schedule.id, USER), true);
    assert.equal(await getSchedule(schedule.id), undefined);
  });
});
