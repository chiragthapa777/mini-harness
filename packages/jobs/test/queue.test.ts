import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { close, query } from "@mini-agent/db";
import { claim, enqueue, getJob, jobStats, listJobs, reapStale, retryJob } from "../src/queue.js";
import { runJob } from "../src/worker.js";

/**
 * The queue is SQL, so testing it against anything but Postgres would only
 * test a mock. Without a database configured the suite skips rather than
 * fails — `pnpm test` still has to pass on a laptop with no docker running.
 */
const configured = Boolean(process.env.DATABASE_URL);
const USER = "jobs-test-user";

describe("job queue", { skip: configured ? false : "DATABASE_URL not set" }, () => {
  after(async () => {
    await query(`DELETE FROM jobs WHERE user_id = $1`, [USER]);
    await close();
  });

  const clean = () => query(`DELETE FROM jobs WHERE user_id = $1`, [USER]);
  const mine = async (limit = 10) =>
    (await claim(limit)).filter((job) => job.user_id === USER);

  it("dedupes live work by key", async () => {
    await clean();
    const first = await enqueue(
      "dedupe_facts",
      { userId: USER },
      { userId: USER, dedupeKey: `${USER}:dedupe` },
    );
    const second = await enqueue(
      "dedupe_facts",
      { userId: USER },
      { userId: USER, dedupeKey: `${USER}:dedupe` },
    );

    assert.equal(typeof first, "string");
    assert.equal(second, null, "a live job already holds the key");
  });

  it("claims exclusively and hands back the typed payload", async () => {
    await clean();
    await enqueue("dedupe_facts", { userId: USER }, { userId: USER });

    const claimed = await mine();
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]?.status, "running");
    assert.equal(claimed[0]?.attempts, 1);
    assert.equal((claimed[0]?.payload as { userId: string }).userId, USER);

    assert.equal((await mine()).length, 0, "a running job is not claimable again");
  });

  it("stores the handler's return value on success", async () => {
    await clean();
    const id = await enqueue("dedupe_facts", { userId: USER }, { userId: USER });
    const [job] = await mine();

    await runJob(job!, { dedupe_facts: async () => ({ merged: 3 }) }, silent);

    const done = await getJob(id!);
    assert.equal(done?.status, "succeeded");
    assert.deepEqual(done?.result, { merged: 3 });
  });

  it("retries with backoff, then dead-letters", async () => {
    await clean();
    const id = await enqueue("dedupe_facts", { userId: USER }, { userId: USER, maxAttempts: 2 });
    const boom = { dedupe_facts: async () => { throw new Error("boom"); } };

    const [first] = await mine();
    await runJob(first!, boom, silent);

    const requeued = await getJob(id!);
    assert.equal(requeued?.status, "queued", "first failure retries");
    assert.ok(
      requeued!.scheduled_for.getTime() > Date.now(),
      "the retry is pushed into the future by the backoff",
    );

    // Pull the retry forward rather than waiting out the backoff.
    await query(`UPDATE jobs SET scheduled_for = now() WHERE id = $1`, [id]);
    const [second] = await mine();
    await runJob(second!, boom, silent);

    const dead = await getJob(id!);
    assert.equal(dead?.status, "failed");
    assert.equal(dead?.attempts, 2);
    assert.equal(dead?.last_error, "boom");
    assert.ok(dead?.finished_at, "a dead-lettered job is finished, not pending");

    const retried = await retryJob(id!);
    assert.equal(retried?.status, "queued");
    assert.equal(retried?.attempts, 0, "a hand-retry gets the full budget back");
  });

  it("records an unregistered type instead of throwing", async () => {
    await clean();
    const id = await enqueue("embed_backfill", {}, { userId: USER, maxAttempts: 1 });
    const [job] = await mine();

    await runJob(job!, {}, silent);

    const failed = await getJob(id!);
    assert.equal(failed?.status, "failed");
    assert.match(failed?.last_error ?? "", /no handler registered/);
  });

  it("reaps a claim whose worker died", async () => {
    await clean();
    const id = await enqueue("dedupe_facts", { userId: USER }, { userId: USER });
    await mine();
    await query(`UPDATE jobs SET started_at = now() - interval '1 hour' WHERE id = $1`, [id]);

    assert.ok((await reapStale(60_000)) >= 1);
    assert.equal((await getJob(id!))?.status, "queued");
  });

  it("lists and aggregates for the admin panel", async () => {
    await clean();
    await enqueue("dedupe_facts", { userId: USER }, { userId: USER });

    const { jobs, total } = await listJobs({ userId: USER });
    assert.equal(total, 1);
    assert.equal(jobs[0]?.type, "dedupe_facts");
    assert.ok((await jobStats()).length >= 1);
  });
});

const silent = { info() {}, error() {} };
