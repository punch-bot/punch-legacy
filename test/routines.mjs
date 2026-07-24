import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "punch-routines-"));
process.env.DATA_DIR = dataDir;
process.env.PUNCH_ROUTINE_RETRY_BASE_MS = "1000";
const moduleUrl = new URL("../src/routines.js", import.meta.url);
moduleUrl.searchParams.set("test", `${Date.now()}-${Math.random()}`);
const routines = await import(moduleUrl.href);

test.after(() => {
  routines.stopScheduler();
  rmSync(dataDir, { recursive: true, force: true });
});

test("routine storage is atomic-looking JSON with durable execution history", () => {
  const routine = routines.addRoutine({
    userId: "user", channelId: "channel", type: "message", payload: "hello",
    schedule: { kind: "once", at: Date.now() + 60_000 },
  });
  const stored = JSON.parse(readFileSync(join(dataDir, "routines.json"), "utf8"));
  assert.equal(stored[0].id, routine.id);
  assert.equal(stored[0].state, "queued");
  assert.equal(stored[0].attempts, 0);
});

test("one-shot succeeds once then cleans up while retaining history", async () => {
  const routine = routines.addRoutine({
    userId: "once-user", channelId: "channel", type: "message", payload: "once",
    schedule: { kind: "once", at: Date.now() + 20 },
  });
  let runs = 0;
  routines.startScheduler(async () => { runs += 1; });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(runs, 1);
  assert.equal(routines.getRoutine(routine.id), null);
  assert.equal(routines.listHistory("once-user", routine.id)[0].status, "succeeded");
  routines.stopScheduler();
});

test("failed routine gets bounded retry backoff rather than next-tick loop", async () => {
  const routine = routines.addRoutine({
    userId: "retry-user", channelId: "channel", type: "message", payload: "retry",
    schedule: { kind: "once", at: Date.now() + 20 },
  });
  routines.startScheduler(async () => { throw new Error("delivery failed"); });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const afterFailure = routines.getRoutine(routine.id);
  assert.equal(afterFailure.state, "queued");
  assert.equal(afterFailure.attempts, 1);
  assert.ok(afterFailure.nextRunAt >= Date.now() + 800);
  assert.equal(routines.listHistory("retry-user", routine.id)[0].error, "delivery failed");
  routines.stopScheduler();
});
