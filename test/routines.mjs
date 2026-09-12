import assert from "node:assert/strict";
import test from "node:test";

import * as routines from "../src/routines.js";

test("parseTime resolves shorthand relative to now", () => {
  const before = Date.now();
  const at = routines.parseTime("30m");
  assert.ok(at >= before + 29 * 60_000 && at <= Date.now() + 31 * 60_000);
});

test("parseRecurrence: once, daily, and every", () => {
  assert.equal(routines.parseRecurrence("tomorrow 9am", "once").kind, "once");
  assert.deepEqual(routines.parseRecurrence("9am", "daily", "UTC"), { kind: "cron", cron: "0 9 * * *" });
  assert.deepEqual(routines.parseRecurrence("", "every 6h"), { kind: "interval", everyMs: 6 * 3_600_000 });
});

test("parseEveryInterval maps minutes and hours", () => {
  assert.deepEqual(routines.parseEveryInterval("15m"), { kind: "interval", everyMs: 15 * 60_000 });
  assert.deepEqual(routines.parseEveryInterval("2h"), { kind: "interval", everyMs: 2 * 3_600_000 });
  assert.throws(() => routines.parseEveryInterval("daily"), /Could not parse interval/);
});

test("computeNextRun handles once, interval, and cron", () => {
  const future = Date.now() + 60_000;
  assert.equal(routines.computeNextRun({ kind: "once", at: future }, Date.now()), future);
  assert.equal(routines.computeNextRun({ kind: "interval", everyMs: 1_000 }, 1_000), 2_000);
  assert.ok(routines.computeNextRun({ kind: "cron", cron: "0 9 * * *" }, Date.now(), "UTC") > Date.now());
});

test("formatRoutine renders a human label", () => {
  const text = routines.formatRoutine({
    id: "abc12345",
    type: "message",
    payload: "standup",
    schedule: { kind: "interval", everyMs: 3_600_000 },
    timezone: "UTC",
    nextRunAt: Date.now() + 3_600_000,
    enabled: true,
    state: "queued",
  });
  assert.match(text, /\[remind\]/);
  assert.match(text, /standup/);
});
