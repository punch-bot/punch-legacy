import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDoctorReport, runDoctor } from "../src/doctor/index.js";

const validRoutine = {
  id: "routine-1",
  userId: "123",
  channelId: "456",
  guildId: null,
  type: "message",
  payload: "hello",
  schedule: { kind: "once", at: Date.now() + 60_000 },
  nextRunAt: Date.now() + 60_000,
  lastRunAt: null,
  enabled: true,
  createdAt: Date.now(),
};

function dependencies(fetchImpl) {
  return {
    userId: "123",
    sandboxName: "ember",
    sandbox: {
      loadUsers: () => [{ userId: "123", name: "ember" }],
      isContainerRunning: () => true,
    },
    apiUrl: "http://sandbox-ember:4097",
    gatewayUrl: "http://sandbox-ember:4096",
    routines: { listAll: () => [validRoutine] },
    env: {
      PI_SERVER_PASSWORD: "secret",
      fetch: fetchImpl,
    },
  };
}

function successfulFetch(url) {
  if (String(url).includes("/doctor")) {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        checks: [{ id: "supervisor-pi", status: "pass", title: "Pi process", message: "Pi is ready.", durationMs: 2 }],
      }),
    });
  }
  return Promise.resolve({ ok: true, status: 200 });
}

test("runDoctor summarizes local and supervisor checks", async () => {
  const result = await runDoctor(dependencies(successfulFetch));

  assert.equal(result.summary.pass, 8);
  assert.equal(result.summary.warn, 0);
  assert.equal(result.summary.fail, 0);
  assert.equal(result.summary.info, 0);
  assert.equal(result.checks.length, 8);
  assert.ok(result.durationMs >= 0);
  assert.ok(result.checks.every((item) => Number.isFinite(item.durationMs)));
});

test("runDoctor reports unavailable routing without throwing", async () => {
  const result = await runDoctor({
    userId: "missing",
    sandboxName: null,
    sandbox: { loadUsers: () => [], isContainerRunning: () => false },
    apiUrl: null,
    gatewayUrl: null,
    routines: { listAll: () => [] },
    env: { PI_SERVER_PASSWORD: "" },
  });

  const routing = result.checks.find((item) => item.id === "routing");
  assert.equal(routing.status, "fail");
  assert.match(routing.message, /No sandbox mapping/i);
  assert.ok(result.summary.fail >= 3);
  assert.equal(result.checks.find((item) => item.id === "security-password").status, "warn");
});

test("doctor reports disabled memory with an actionable recovery message", async () => {
  const result = await runDoctor({ ...dependencies(successfulFetch), memory: {
    getMemoryStatus: () => ({ available: false, error: "migration refused: malformed /state/memory/2026-10-17.json" }),
  } });
  const memory = result.checks.find((item) => item.id === "memory");
  assert.equal(memory.status, "fail");
  assert.match(memory.message, /2026-10-17.json/);
  assert.match(memory.fix, /Restore/);
});

test("runDoctor sends the per-sandbox doctor credential", async () => {
  const headers = [];
  await runDoctor({
    ...dependencies(async (url, options) => {
      headers.push(options.headers);
      return successfulFetch(url);
    }),
    doctorToken: "sandbox-secret",
  });

  assert.ok(headers.some((value) => value["x-punch-doctor-token"] === "sandbox-secret"));
});

test("runDoctor contains failed fetches and passes deep to supervisor", async () => {
  const requested = [];
  const result = await runDoctor({
    ...dependencies(async (url) => {
      requested.push(String(url));
      throw new Error("network down");
    }),
    deep: true,
  });

  assert.equal(result.checks.find((item) => item.id === "gateway").status, "fail");
  assert.equal(result.checks.find((item) => item.id === "supervisor").status, "fail");
  assert.ok(requested.some((url) => url.includes("/doctor?deep=true")));
});

test("renderDoctorReport is Discord-safe and capped at 1900 characters", () => {
  const message = "@everyone " + "x".repeat(4_000);
  const report = renderDoctorReport({
    checks: [{ id: "long", status: "warn", title: "Long check", message, durationMs: 1, fix: "Ask @here" }],
    summary: { pass: 0, warn: 1, fail: 0, info: 0 },
    durationMs: 12,
  }, "ember");

  assert.ok(report.length <= 1900);
  assert.match(report, /Punch Doctor — ember/);
  assert.match(report, /Completed in 12ms$/);
  assert.ok(!report.includes("@everyone"));
  assert.ok(!report.includes("@here"));
});

test("renderDoctorReport derives a summary when one is absent", () => {
  const report = renderDoctorReport({
    checks: [
      { id: "a", status: "pass", title: "A", message: "ok", durationMs: 0 },
      { id: "b", status: "fail", title: "B", message: "bad", durationMs: 0 },
    ],
    durationMs: 0,
  }, "ember");

  assert.match(report, /1 passed · 0 warnings · 1 failed · 0 info/);
});
