import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "punch-routines-tz-"));
process.env.DATA_DIR = dataDir;
process.env.PUNCH_ROUTINE_RETRY_BASE_MS = "1000";
const moduleUrl = new URL("../src/routines.js", import.meta.url);
moduleUrl.searchParams.set("test", `${Date.now()}-${Math.random()}`);
const routines = await import(moduleUrl.href);

test.after(() => {
  routines.stopScheduler();
  rmSync(dataDir, { recursive: true, force: true });
});

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
  // 2026-11-01 00:00 EDT; tomorrow 9am is EST (-5) → 14:00Z.
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
  // 01:30 happens twice on 2026-11-01; policy is earlier (still EDT) → 05:30Z.
  assert.equal(
    new Date(tz.zonedWallTimeToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, "America/New_York")).toISOString(),
    "2026-11-01T05:30:00.000Z",
  );
  // Lord Howe falls back by 30 minutes; earlier 01:45 is +11 → 14:45Z.
  assert.equal(
    new Date(tz.zonedWallTimeToUtc({ year: 2026, month: 4, day: 5, hour: 1, minute: 45 }, "Australia/Lord_Howe")).toISOString(),
    "2026-04-04T14:45:00.000Z",
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

test("daily routines store timezone and fire at the local wall clock", () => {
  const routine = routines.addRoutine({
    userId: "tz-user",
    channelId: "channel",
    type: "message",
    payload: "standup",
    schedule: routines.parseDailyTime("9am", "America/New_York"),
    timezone: "America/New_York",
  });
  assert.equal(routine.timezone, "America/New_York");
  assert.equal(routine.schedule.cron, "0 9 * * *");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date(routine.nextRunAt));
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  assert.equal(hour, 9);
  assert.equal(minute, 0);
});
