import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "punch-routing-"));
process.env.DATA_DIR = dataDir;
delete process.env.PI_SERVER_URL;
delete process.env.SANDBOX_MAP;
const agent = await import("../src/agent.js");

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

test("registered users route to their own sandbox and unregistered users get none", () => {
  writeFileSync(join(dataDir, "sandbox_users.json"), JSON.stringify([{ userId: "alice", name: "ember" }]));
  agent.reloadSandboxMap();
  assert.equal(agent.apiUrlFor("alice"), "http://sandbox-ember:4097");
  assert.equal(agent.sandboxNameForUser("alice"), "ember");
  assert.equal(agent.apiUrlFor("mallory"), null);
  assert.equal(agent.sandboxNameForUser("mallory"), null);
});

test("an unregistered user's turn fails before any request leaves the bot", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("network must not be used");
  });
  await assert.rejects(agent.runAgent("hi", null, null, null, "mallory"), /No sandbox assigned/);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("a missing or corrupt users file routes nobody", () => {
  writeFileSync(join(dataDir, "sandbox_users.json"), "{ not json");
  agent.reloadSandboxMap();
  assert.equal(agent.apiUrlFor("alice"), null);
});

test("stuck-turn errors are recognised and ordinary failures are not", () => {
  assert.equal(agent.isStuckTurnError("pi stalled: no progress for 90s (session stuck)"), true);
  assert.equal(agent.isStuckTurnError("pi turn exceeded 1800s ceiling"), true);
  assert.equal(agent.isStuckTurnError("pi silent for 120s (turn hung)"), true);
  assert.equal(agent.isStuckTurnError("aborted"), false);
  assert.equal(agent.isStuckTurnError("pi API 500: boom"), false);
});

test("idle watchdog resets on real progress but heartbeats alone never count as progress", () => {
  const progress = (properties) => ({ type: "session.progress", properties: { status: "running", ...properties } });
  const thinking = agent.classifyIdleWatchdogEvent(progress({ phase: "thinking", current: "Thinking", toolCalls: 0 }), "");
  assert.equal(thinking.resetMeaningful, true);

  const repeat = agent.classifyIdleWatchdogEvent(progress({ phase: "thinking", current: "Thinking", toolCalls: 0, elapsedMs: 20_000 }), thinking.fingerprint);
  assert.equal(repeat.resetMeaningful, false);
  assert.equal(repeat.resetKeepalive, false);

  const tool = agent.classifyIdleWatchdogEvent(progress({ phase: "tool", current: "Running a command", toolCalls: 1 }), thinking.fingerprint);
  assert.equal(tool.resetMeaningful, true);

  const heartbeat = agent.classifyIdleWatchdogEvent(progress({ phase: "tool", current: "Running a command", toolCalls: 1, heartbeat: true }), tool.fingerprint);
  assert.equal(heartbeat.resetMeaningful, false);
  assert.equal(heartbeat.resetKeepalive, true);

  const text = agent.classifyIdleWatchdogEvent({ type: "message.part.delta", properties: { sessionID: "s", delta: { text: "hi" } } }, tool.fingerprint);
  assert.equal(text.resetMeaningful, true);
});
