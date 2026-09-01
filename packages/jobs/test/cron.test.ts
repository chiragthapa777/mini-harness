import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isValidCron, nextRun, nextRuns } from "../src/cron.js";

const at = (iso: string) => new Date(iso);
const next = (expr: string, from: string) => nextRun(expr, at(from))?.toISOString();

describe("cron", () => {
  it("fires every five minutes on the boundary", () => {
    assert.equal(next("*/5 * * * *", "2026-01-01T10:02:30Z"), "2026-01-01T10:05:00.000Z");
    assert.equal(next("*/5 * * * *", "2026-01-01T10:05:00Z"), "2026-01-01T10:10:00.000Z");
  });

  it("is strictly after `from`, so a tick cannot re-fire itself", () => {
    assert.equal(next("* * * * *", "2026-01-01T10:00:00Z"), "2026-01-01T10:01:00.000Z");
  });

  it("rolls over hours, days, and years", () => {
    assert.equal(next("0 * * * *", "2026-01-01T10:30:00Z"), "2026-01-01T11:00:00.000Z");
    assert.equal(next("30 3 * * *", "2026-01-01T04:00:00Z"), "2026-01-02T03:30:00.000Z");
    assert.equal(next("0 0 1 1 *", "2026-06-15T00:00:00Z"), "2027-01-01T00:00:00.000Z");
  });

  it("handles lists, ranges, and steps within ranges", () => {
    assert.equal(next("0,30 * * * *", "2026-01-01T10:05:00Z"), "2026-01-01T10:30:00.000Z");
    assert.equal(next("0 9-17 * * *", "2026-01-01T18:00:00Z"), "2026-01-02T09:00:00.000Z");
    assert.equal(next("0 0-12/6 * * *", "2026-01-01T01:00:00Z"), "2026-01-01T06:00:00.000Z");
    assert.equal(next("5/10 * * * *", "2026-01-01T10:06:00Z"), "2026-01-01T10:15:00.000Z");
  });

  it("treats day-of-week 0 and 7 as Sunday", () => {
    // 2026-01-04 is a Sunday.
    assert.equal(next("0 0 * * 0", "2026-01-01T00:00:00Z"), "2026-01-04T00:00:00.000Z");
    assert.equal(next("0 0 * * 7", "2026-01-01T00:00:00Z"), "2026-01-04T00:00:00.000Z");
  });

  it("ORs day-of-month and day-of-week when both are restricted", () => {
    // The 1st is a Thursday; the OR means the following Friday also fires.
    assert.equal(next("0 0 1 * 5", "2026-01-01T12:00:00Z"), "2026-01-02T00:00:00.000Z");
  });

  it("expands the @ aliases", () => {
    assert.equal(next("@daily", "2026-01-01T10:00:00Z"), "2026-01-02T00:00:00.000Z");
    assert.equal(next("@hourly", "2026-01-01T10:10:00Z"), "2026-01-01T11:00:00.000Z");
  });

  it("returns null for a date that never comes", () => {
    assert.equal(nextRun("0 0 30 2 *", at("2026-01-01T00:00:00Z")), null);
  });

  it("rejects malformed expressions", () => {
    assert.equal(isValidCron("*/5 * * * *"), true);
    assert.equal(isValidCron("nope"), false);
    assert.equal(isValidCron("* * * *"), false, "four fields");
    assert.equal(isValidCron("60 * * * *"), false, "minute out of range");
    assert.equal(isValidCron("* * * * 8"), false, "day-of-week out of range");
    assert.equal(isValidCron("*/0 * * * *"), false, "zero step");
    assert.equal(isValidCron("a * * * *"), false, "not a number");
  });

  it("rejects sub-minute patterns, which the queue could not honour anyway", () => {
    // Croner accepts 6- and 7-field patterns by default; pinning it to 5 keeps
    // "every second" unexpressible, so the finest schedule is one a minute.
    assert.equal(isValidCron("* * * * * *"), false, "six fields (leading seconds)");
    assert.equal(isValidCron("0 * * * * * 2027"), false, "seven fields (trailing year)");
  });

  it("rejects an expression that can never fire", () => {
    // Well-formed, but the 30th of February does not happen.
    assert.equal(isValidCron("0 0 30 2 *"), false);
  });

  it("resolves in UTC regardless of the server's timezone", () => {
    // Would be an off-by-hours failure if croner were left on local time.
    assert.equal(next("0 3 * * *", "2026-06-15T12:00:00Z"), "2026-06-16T03:00:00.000Z");
    assert.equal(next("0 0 * * *", "2026-01-01T23:30:00Z"), "2026-01-02T00:00:00.000Z");
  });

  it("enumerates the next few firings for a preview", () => {
    const runs = nextRuns("0 * * * *", 3, at("2026-01-01T10:30:00Z"));
    assert.deepEqual(
      runs.map((r) => r.toISOString()),
      ["2026-01-01T11:00:00.000Z", "2026-01-01T12:00:00.000Z", "2026-01-01T13:00:00.000Z"],
    );
  });
});
