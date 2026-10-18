import assert from "node:assert/strict";
import { classifyIdleWatchdogEvent, isStuckTurnError, progressEventFingerprint } from "../src/agent.js";

assert.equal(isStuckTurnError("pi stalled: no progress for 90s (session stuck)"), true);
assert.equal(isStuckTurnError("pi stalled: working hung for 180s without real progress"), true);
assert.equal(isStuckTurnError("pi turn exceeded 1800s ceiling"), false);
assert.equal(isStuckTurnError("pi turn exceeded 300s hard timeout"), false);
assert.equal(isStuckTurnError("turn exceeded 300s hard cap"), false);
assert.equal(isStuckTurnError("provider timed out"), false);
assert.equal(isStuckTurnError("pi silent for 120s (turn hung)"), true);
assert.equal(isStuckTurnError("aborted"), false);
assert.equal(isStuckTurnError("pi API 500: boom"), false);

const thinking = {
  type: "session.progress",
  properties: { phase: "thinking", status: "running", current: "Thinking", toolCalls: 0 },
};
const thinkingLater = {
  type: "session.progress",
  properties: { ...thinking.properties, elapsedMs: 20_000 },
};
assert.equal(progressEventFingerprint(thinking), progressEventFingerprint(thinkingLater));

const heartbeatThinking = {
  type: "session.progress",
  properties: { ...thinking.properties, heartbeat: true },
};
assert.equal(progressEventFingerprint(heartbeatThinking), null);

const first = classifyIdleWatchdogEvent(thinking, "");
assert.equal(first.resetMeaningful, true);
assert.equal(first.resetKeepalive, true);

const dup = classifyIdleWatchdogEvent(thinkingLater, first.fingerprint);
assert.equal(dup.resetMeaningful, false);
assert.equal(dup.resetKeepalive, false);

const hbThink = classifyIdleWatchdogEvent(heartbeatThinking, first.fingerprint);
assert.equal(hbThink.resetMeaningful, false);
assert.equal(hbThink.resetKeepalive, true, "thinking heartbeats may keep the turn alive");

const heartbeatWorking = {
  type: "session.progress",
  properties: { phase: "working", status: "running", current: "Working", toolCalls: 1, heartbeat: true },
};
const hbWork = classifyIdleWatchdogEvent(heartbeatWorking, first.fingerprint);
assert.equal(hbWork.resetMeaningful, false);
assert.equal(hbWork.resetKeepalive, true, "working heartbeats keep silence alive so TOOL_STALE_MS can fire");

const toolStart = {
  type: "session.progress",
  properties: { phase: "tool", status: "running", current: "Running a command", toolCalls: 2 },
};
const tool = classifyIdleWatchdogEvent(toolStart, first.fingerprint);
assert.equal(tool.resetMeaningful, true);
assert.equal(tool.phase, "tool");

const heartbeatTool = {
  type: "session.progress",
  properties: { phase: "tool", status: "running", current: "Running a command", toolCalls: 2, heartbeat: true },
};
const hbTool = classifyIdleWatchdogEvent(heartbeatTool, tool.fingerprint);
assert.equal(hbTool.resetMeaningful, false, "tool heartbeats alone are not meaningful progress");
assert.equal(hbTool.resetKeepalive, true, "tool heartbeats keep silence alive so TOOL_STALE_MS can fire");

const delta = classifyIdleWatchdogEvent({
  type: "message.part.delta",
  properties: { sessionID: "s", delta: { text: "hi" } },
}, tool.fingerprint);
assert.equal(delta.resetMeaningful, true);

console.log("ok: stuck-turn recovery detection");
