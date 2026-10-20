import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "punch-routines-"));
process.env.DATA_DIR = dataDir;
process.env.PUNCH_ROUTINE_RETRY_BASE_MS = "1000";
const routines = await import("../src/routines.js");

test.after(() => {
  routines.stopScheduler();
  rmSync(dataDir, { recursive: true, force: true });
});

const iso = (ms) => new Date(ms).toISOString();

test("times are read in the user's timezone, across DST changes", () => {
  const tz = "America/New_York";
  assert.equal(iso(routines.parseTime("tomorrow 9am", new Date("2026-08-10T15:00:00Z"), tz)), "2026-08-11T13:00:00.000Z");
  assert.equal(iso(routines.parseTime("tomorrow 9am", new Date("2026-03-08T04:00:00Z"), tz)), "2026-03-08T13:00:00.000Z");
  assert.equal(iso(routines.parseTime("tomorrow 9am", new Date("2026-11-01T04:00:00Z"), tz)), "2026-11-02T14:00:00.000Z");
  assert.equal(iso(routines.parseTime("2026-04-01T09:00:00-05:00", new Date("2026-04-01T00:00:00Z"), tz)), "2026-04-01T14:00:00.000Z");
});

test("daily routines fire at the local wall clock", () => {
  const routine = routines.addRoutine({
    userId: "tz-user", channelId: "channel", type: "message", payload: "standup",
    schedule: routines.parseDailyTime("9am", "America/New_York"), timezone: "America/New_York",
  });
  assert.equal(routine.schedule.cron, "0 9 * * *");
  const local = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "numeric", hourCycle: "h23" }).format(new Date(routine.nextRunAt));
  assert.equal(local, "09:00");
  routines.removeRoutine(routine.id, "tz-user");
});

test("a one-shot routine fires exactly once and keeps its history", async () => {
  const routine = routines.addRoutine({
    userId: "once-user", channelId: "channel", type: "message", payload: "once",
    schedule: { kind: "once", at: Date.now() + 20 },
  });
  let runs = 0;
  routines.startScheduler(async () => { runs += 1; });
  await new Promise((resolve) => setTimeout(resolve, 100));
  routines.stopScheduler();
  assert.equal(runs, 1);
  assert.equal(routines.getRoutine(routine.id), null);
  assert.equal(routines.listHistory("once-user", routine.id)[0].status, "succeeded");
});

test("a failing routine backs off instead of retrying every tick", async () => {
  const routine = routines.addRoutine({
    userId: "retry-user", channelId: "channel", type: "message", payload: "retry",
    schedule: { kind: "once", at: Date.now() + 20 },
  });
  routines.startScheduler(async () => { throw new Error("delivery failed"); });
  await new Promise((resolve) => setTimeout(resolve, 100));
  routines.stopScheduler();
  const after = routines.getRoutine(routine.id);
  assert.equal(after.attempts, 1);
  assert.ok(after.nextRunAt >= Date.now() + 800);
  assert.equal(routines.listHistory("retry-user", routine.id)[0].error, "delivery failed");
});

test("built-in memory audits follow registered users and cannot be removed", () => {
  routines.syncMemoryAudits([{ userId: "audit-a", timezone: "Europe/Berlin" }, { userId: "audit-b" }]);
  routines.syncMemoryAudits([{ userId: "audit-a", timezone: "Europe/Berlin" }, { userId: "audit-b" }]);
  const audits = () => routines.listAll().filter((routine) => routine.type === routines.MEMORY_AUDIT_TYPE);
  assert.deepEqual(audits().map((routine) => [routine.userId, routine.timezone, routine.isolatedSession]), [["audit-a", "Europe/Berlin", true], ["audit-b", "UTC", true]]);
  const [audit] = audits();
  assert.match(audit.schedule.cron, /^\d+ [345] \* \* [0-6]$/);
  assert.equal(routines.removeRoutine(audit.id, "audit-a"), false);
  assert.equal(routines.pauseRoutine(audit.id, "audit-a").enabled, false);
  routines.syncMemoryAudits([{ userId: "audit-a", timezone: "Europe/Berlin" }]);
  assert.deepEqual(audits().map((routine) => [routine.userId, routine.enabled]), [["audit-a", false]]);
});
