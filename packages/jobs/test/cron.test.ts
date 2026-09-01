import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isValidCron, nextRun, parseCron } from "../src/cron.js";

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

  it("rejects malformed expressions loudly", () => {
    assert.throws(() => parseCron("* * * *"), /needs 5 fields/);
    assert.throws(() => parseCron("60 * * * *"), /out of range/);
    assert.throws(() => parseCron("* * * * 8"), /out of range/);
    assert.throws(() => parseCron("*/0 * * * *"), /step must be >= 1/);
    assert.throws(() => parseCron("a * * * *"), /invalid cron field/);
    assert.equal(isValidCron("*/5 * * * *"), true);
    assert.equal(isValidCron("nope"), false);
  });
});
