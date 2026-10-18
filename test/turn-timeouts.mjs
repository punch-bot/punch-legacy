import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { turnTimeouts } from "../src/turn-timeouts.js";
import { abortPiTurn } from "../docker/sandbox/usr/local/lib/pi-turn-abort.mjs";

test("turn caps inherit the deployment timeout and reject invalid timer values", () => {
  assert.deepEqual(turnTimeouts({}), { request: 1800, ceiling: 1800, hard: 1800 });
  assert.deepEqual(turnTimeouts({ PI_TIMEOUT: "2400" }), { request: 2400, ceiling: 2400, hard: 2400 });
  assert.deepEqual(turnTimeouts({ PI_TIMEOUT: "2400", PI_MAX: "2500", PI_HARD_TIMEOUT: "2600" }),
    { request: 2400, ceiling: 2500, hard: 2600 });
  for (const value of ["-1", "0", "nope", "Infinity", "3000000"]) {
    assert.equal(turnTimeouts({ PI_TIMEOUT: value }).hard, 1800);
  }
});

test("routine gateway abort preserves a responsive child; unresponsive cancellation restarts it", async () => {
  for (const mode of ["idle", "settles", "hung", "rpc-fails"]) {
    let resolveSettled;
    let rejectSettled;
    let cancelled = false;
    const settled = new Promise((resolve, reject) => { resolveSettled = resolve; rejectSettled = reject; });
    settled.cancel = () => { cancelled = true; rejectSettled(new Error("cancelled")); };
    const kills = [];
    await abortPiTurn({
      rpc: async (type) => {
        if (mode === "rpc-fails") throw new Error("unresponsive");
        if (type === "abort" && mode === "settles") resolveSettled();
        return { data: { isStreaming: mode !== "idle" } };
      },
      waitTurn: () => settled,
      forceKillPi: (reason) => kills.push(reason),
      graceMs: 30,
      reason: "turn deadline",
    });
    assert.equal(kills.length, ["hung", "rpc-fails"].includes(mode) ? 1 : 0, mode);
    assert.equal(cancelled, true, mode);
  }
});

test("bot allows active turns past the old configured request timeout, cancels caps, and recovers only stalls", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "punch-timeouts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.mock.method(console, "log", () => {});
  for (const mode of ["long", "deadline", "gateway-deadline", "stall"]) {
    const requests = [];
    t.mock.method(globalThis, "fetch", async (input, options = {}) => {
      const path = new URL(input).pathname;
      requests.push(path);
      if (path === "/file/content") return Response.json({ type: "text", content: "Test system" });
      if (path === "/model") return Response.json({});
      if (path === "/event") {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected"}\n\n'));
            options.signal.addEventListener("abort", () => controller.close(), { once: true });
          },
        }));
      }
      if (path.endsWith("/message")) {
        if (mode === "gateway-deadline") return Response.json({ error: "turn exceeded 2400s hard cap" }, { status: 504 });
        return new Promise((resolve, reject) => {
          const timer = mode === "long" ? setTimeout(() => resolve(Response.json({ parts: [{ type: "text", text: "Completed" }] })), 120) : null;
          options.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        });
      }
      return Response.json({ ok: true });
    });
    const saved = { ...process.env };
    Object.assign(process.env, {
      DATA_DIR: dir, SANDBOX_MAP: JSON.stringify({ tester: "http://sandbox-timeouts:4096" }),
      PI_TIMEOUT: "0.03", PI_MAX: mode === "deadline" ? "0.06" : "10",
      PI_HARD_TIMEOUT: mode === "long" ? "0.5" : mode === "deadline" ? "0.06" : "10",
      PI_IDLE_TIMEOUT: mode === "stall" ? "0.03" : "10",
    });
    try {
      const agent = await import(`../src/agent.js?timeouts=${mode}`);
      if (mode === "long") {
        assert.equal((await agent.runAgent("test", "sid", null, null, "tester")).text, "Completed");
      } else {
        await assert.rejects(agent.runAgent("test", "sid", null, null, "tester"));
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(requests.includes("/doctor/fix"), mode === "stall", mode);
      if (mode === "deadline") assert.ok(requests.includes("/session/sid/abort"));
      // Recovery's health poll runs after 500ms; finish it before restoring fetch.
      if (mode === "stall") await new Promise((resolve) => setTimeout(resolve, 550));
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      t.mock.restoreAll();
    }
  }
});
