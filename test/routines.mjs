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

function withFetch(handler, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, body: init.body });
    const result = await handler(String(url), init);
    return {
      ok: result.status ? result.status < 400 : true,
      status: result.status ?? 200,
      text: async () => JSON.stringify(result.data ?? {}),
    };
  };
  return Promise.resolve(run(calls)).finally(() => {
    globalThis.fetch = original;
  });
}

test("CRUD proxies to the supervisor", async () => {
  const routine = { id: "r1", userId: "u1", payload: "ping" };
  await withFetch(
    (url) => {
      if (url.includes("/routines?userId=")) return { data: { routines: [routine] } };
      if (url.includes("/routines/history")) return { data: { history: [{ id: "h1" }] } };
      if (/\/routines\/r1\/history/.test(url)) return { data: { history: [{ id: "h2" }] } };
      return { data: { routine, ok: true } };
    },
    async (calls) => {
      assert.deepEqual(await routines.listRoutines("u1"), [routine]);
      assert.deepEqual(await routines.listHistory("u1"), [{ id: "h1" }]);
      assert.deepEqual(await routines.listHistory("u1", "r1"), [{ id: "h2" }]);
      assert.deepEqual(await routines.addRoutine({ userId: "u1", when: "30m" }), routine);
      assert.equal(await routines.removeRoutine("r1", "u1"), true);
      assert.equal((await routines.setRoutineEnabled("r1", "u1", false)).id, "r1");
      assert.equal((await routines.setRoutineEnabled("r1", "u1", true)).id, "r1");
      assert.match(calls.find((c) => c.method === "DELETE").url, /\/routines\/r1\?userId=u1/);
      assert.match(calls.find((c) => c.url.includes("/pause")).url, /\/routines\/r1\/pause/);
      assert.match(calls.find((c) => c.url.includes("/resume")).url, /\/routines\/r1\/resume/);
    },
  );
});

test("supervisor errors propagate", async () => {
  await withFetch(
    () => ({ status: 503, data: { error: "supervisor down" } }),
    async () => {
      await assert.rejects(() => routines.listRoutines("u1"), /supervisor down/);
      await assert.rejects(() => routines.addRoutine({ userId: "u1" }), /supervisor down/);
      await assert.rejects(() => routines.listHistory("u1"), /supervisor down/);
    },
  );
});
