import assert from "node:assert/strict";
import test from "node:test";

import * as routines from "../src/routines.js";

test("parseTime interprets wall clock times in the user timezone", () => {
  const ref = new Date("2026-08-10T15:00:00.000Z");
  const at = routines.parseTime("tomorrow 9am", ref, "America/New_York");
  assert.equal(new Date(at).toISOString(), "2026-08-11T13:00:00.000Z");
});

test("parseTime resolves spring-forward DST with target-date offset", () => {
  // 2026-03-08 00:00 EDT is after the spring-forward; ref is still EST (-5).
  const ref = new Date("2026-03-08T04:00:00.000Z");
  const at = routines.parseTime("tomorrow 9am", ref, "America/New_York");
  assert.equal(new Date(at).toISOString(), "2026-03-08T13:00:00.000Z");
});

test("parseTime resolves fall-back DST with target-date offset", () => {
  // 2026-11-01 00:00 EDT; tomorrow 9am is EST (-5) -> 14:00Z.
  const ref = new Date("2026-11-01T04:00:00.000Z");
  const at = routines.parseTime("tomorrow 9am", ref, "America/New_York");
  assert.equal(new Date(at).toISOString(), "2026-11-02T14:00:00.000Z");
});

test("parseTime preserves explicit Z and numeric offsets", () => {
  const ref = new Date("2026-04-01T00:00:00.000Z");
  assert.equal(
    new Date(routines.parseTime("2026-04-01T09:00:00Z", ref, "America/New_York")).toISOString(),
    "2026-04-01T09:00:00.000Z",
  );
  assert.equal(
    new Date(routines.parseTime("2026-04-01T09:00:00-05:00", ref, "America/New_York")).toISOString(),
    "2026-04-01T14:00:00.000Z",
  );
});

test("zonedWallTimeToUtc rejects spring-forward gap and prefers earlier fall-back", async () => {
  const tz = await import("../src/timezone.js");
  assert.throws(
    () => tz.zonedWallTimeToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, "America/New_York"),
    /does not exist in America\/New_York/,
  );
  // 01:30 happens twice on 2026-11-01; policy is earlier (still EDT) -> 05:30Z.
  assert.equal(
    new Date(tz.zonedWallTimeToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, "America/New_York")).toISOString(),
    "2026-11-01T05:30:00.000Z",
  );
  // Lord Howe falls back by 30 minutes; earlier 01:45 is +11 -> 14:45Z.
  assert.equal(
    new Date(tz.zonedWallTimeToUtc({ year: 2026, month: 4, day: 5, hour: 1, minute: 45 }, "Australia/Lord_Howe")).toISOString(),
    "2026-04-04T14:45:00.000Z",
  );
  // Chatham falls back by 1h between +13:45 and +12:45; earlier 03:00 -> 13:15Z.
  assert.equal(
    new Date(tz.zonedWallTimeToUtc({ year: 2026, month: 4, day: 5, hour: 3, minute: 0 }, "Pacific/Chatham")).toISOString(),
    "2026-04-04T13:15:00.000Z",
  );
});

test("parseRecurrence daily builds cron fields from the user timezone", () => {
  const schedule = routines.parseRecurrence("9am", "daily", "America/New_York");
  assert.equal(schedule.kind, "cron");
  assert.equal(schedule.cron, "0 9 * * *");
});

test("daily recurrence cron stays wall-clock across DST transitions", () => {
  const spring = routines.parseRecurrence("9am", "daily", "America/New_York");
  const fall = routines.parseRecurrence("9am", "daily", "America/New_York");
  assert.equal(spring.cron, "0 9 * * *");
  assert.equal(fall.cron, "0 9 * * *");
});

test("parseDailyTime builds a cron from the user timezone", () => {
  const schedule = routines.parseDailyTime("9am", "America/New_York");
  assert.equal(schedule.kind, "cron");
  assert.equal(schedule.cron, "0 9 * * *");
  // The cron is wall-clock local, so the same 9am resolves to a different UTC
  // instant across DST: 14:00Z in winter (EST) and 13:00Z in summer (EDT).
  const winter = routines.computeNextRun(schedule, Date.parse("2026-01-15T12:00:00Z"), "America/New_York");
  assert.equal(new Date(winter).toISOString(), "2026-01-15T14:00:00.000Z");
  const summer = routines.computeNextRun(schedule, Date.parse("2026-07-15T12:00:00Z"), "America/New_York");
  assert.equal(new Date(summer).toISOString(), "2026-07-15T13:00:00.000Z");
});

test("computeNextRun keeps a cron on the local wall clock across DST", () => {
  // Winter is GMT (+0): next 9am London is 09:00Z.
  const winter = routines.computeNextRun({ kind: "cron", cron: "0 9 * * *" }, Date.parse("2026-01-15T12:00:00Z"), "Europe/London");
  assert.match(routines.formatInTimeZone(winter, "Europe/London"), /9:00 AM/);
  assert.equal(new Date(winter).getUTCHours(), 9);
  // Summer is BST (+1): still 9am local, i.e. 08:00Z.
  const summer = routines.computeNextRun({ kind: "cron", cron: "0 9 * * *" }, Date.parse("2026-07-15T12:00:00Z"), "Europe/London");
  assert.match(routines.formatInTimeZone(summer, "Europe/London"), /9:00 AM/);
  assert.equal(new Date(summer).getUTCHours(), 8);
});

test("computeNextRun honors active hours", () => {
  const activeHours = { start: 9, end: 17, timezone: "America/New_York" };
  // 2026-08-10T15:00Z is 11:00 EDT (inside), 2026-08-10T03:00Z is 23:00 EDT (outside).
  const inside = routines.computeNextRun({ kind: "interval", everyMs: 60_000 }, Date.parse("2026-08-10T15:00:00Z"), "America/New_York", activeHours);
  assert.equal(new Date(inside).toISOString(), "2026-08-10T15:01:00.000Z");
  const outside = routines.computeNextRun({ kind: "interval", everyMs: 60_000 }, Date.parse("2026-08-10T03:00:00Z"), "America/New_York", activeHours);
  assert.equal(new Date(outside).toISOString(), "2026-08-10T13:00:00.000Z");
  assert.match(routines.formatInTimeZone(outside, "America/New_York"), /9:00 AM/);
});
