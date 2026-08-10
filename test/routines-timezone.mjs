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

test("parseRecurrence daily builds cron fields from the user timezone", () => {
  const schedule = routines.parseRecurrence("9am", "daily", "America/New_York");
  assert.equal(schedule.kind, "cron");
  assert.equal(schedule.cron, "0 9 * * *");
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
