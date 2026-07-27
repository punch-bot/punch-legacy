import assert from "node:assert/strict";
import test from "node:test";

import {
  applyProgressActivity,
  createProgressRenderer,
  createProgressState,
  finishProgressState,
  reduceProgressEvent,
  renderProgressLive,
  renderProgressRecap,
  sanitizeProgressText,
} from "../src/progress-ui.js";

function gatewayProgress(properties) {
  return { type: "session.progress", properties: { sessionID: "session-1", ...properties } };
}

function fakeClock(start = 0) {
  let time = start;
  const timers = [];
  return {
    now: () => time,
    setTimer(fn, delay) {
      const timer = { fn, at: time + delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      timer.cleared = true;
    },
    nextDelay() {
      const timer = timers.filter((item) => !item.cleared).sort((a, b) => a.at - b.at)[0];
      return timer ? timer.at - time : null;
    },
    runNext() {
      const timer = timers.filter((item) => !item.cleared).sort((a, b) => a.at - b.at)[0];
      assert.ok(timer, "expected a scheduled timer");
      timer.cleared = true;
      time = timer.at;
      timer.fn();
    },
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test("sanitizer caps text, strips controls, redacts assignments, and neutralizes mentions", () => {
  const value = sanitizeProgressText(
    `Ping @everyone <@123> API_KEY=super-secret\u0000 ${"x".repeat(300)}`,
    80,
  );
  assert.ok(value.length <= 80);
  assert.equal(value.includes("@"), false);
  assert.equal(value.includes("<@123>"), false);
  assert.equal(value.includes("super-secret"), false);
  assert.equal(value.includes("\u0000"), false);
  assert.match(value, /\(at\)everyone/);
});

test("gateway progress is primary and carries explicit safe milestones", () => {
  let state = createProgressState(1_000);
  state = reduceProgressEvent(state, gatewayProgress({
    phase: "tool",
    status: "running",
    current: "Reading src/a\\.js",
    elapsedMs: 2_000,
    thinkingMs: 500,
    toolCalls: 2,
    goal: "Verify parser",
    finding: "Found malformed input",
    next: "Add focused test",
  }), 3_000);

  assert.equal(state.source, "gateway");
  assert.equal(state.phase, "tool");
  assert.equal(state.current, "Reading src/a\\.js");
  assert.equal(state.toolCalls, 2);
  assert.equal(state.thinkingMs, 500);
  assert.deepEqual(state.milestones, [{
    goal: "Verify parser",
    finding: "Found malformed input",
    next: "Add focused test",
  }]);

  const unchanged = reduceProgressEvent(state, {
    type: "message.part.updated",
    properties: {
      part: {
        type: "tool",
        id: "legacy",
        tool: "bash",
        state: { status: "running", title: "stale overwrite" },
      },
    },
  }, 4_000);
  assert.equal(unchanged, state);
});

test("legacy fallback uses titles and metadata only, never deltas, args, or output", () => {
  let state = createProgressState(0);
  state = reduceProgressEvent(state, {
    type: "message.part.delta",
    properties: { delta: { text: "private chain of thought" } },
  }, 1_000);
  assert.equal(state.current, "Writing the response");
  assert.equal(JSON.stringify(state).includes("private chain of thought"), false);

  const tool = {
    type: "message.part.updated",
    properties: {
      part: {
        type: "tool",
        id: "call-1",
        tool: "read",
        arguments: { password: "raw argument" },
        state: {
          status: "running",
          title: "Reading file @everyone",
          input: { token: "raw input" },
          output: "raw output",
        },
      },
    },
  };
  state = reduceProgressEvent(state, tool, 2_000);
  state = reduceProgressEvent(state, tool, 2_100);
  const serialized = JSON.stringify(state);
  assert.equal(state.toolCalls, 1);
  assert.equal(state.current, "Reading file (at)everyone");
  for (const hidden of ["raw argument", "raw input", "raw output"]) {
    assert.equal(serialized.includes(hidden), false);
  }
});

test("live render shows phase, elapsed, tools, current action, and milestone fields", () => {
  let state = createProgressState(1_000);
  state = reduceProgressEvent(state, gatewayProgress({
    phase: "milestone",
    status: "running",
    current: "Running focused tests",
    elapsedMs: 12_000,
    thinkingMs: 4_000,
    toolCalls: 3,
    goal: "Ship renderer",
    finding: "One race fixed",
    next: "Run full suite",
  }), 13_000);
  const text = renderProgressLive(state, 13_000);
  assert.match(text, /\*\*Progress\*\* · 12s · 3 tools/);
  assert.match(text, /\*\*Current:\*\* Running focused tests/);
  assert.match(text, /\*\*Goal:\*\* Ship renderer/);
  assert.match(text, /\*\*Finding:\*\* One race fixed/);
  assert.match(text, /\*\*Next:\*\* Run full suite/);
  assert.ok(text.length <= 1900);
});

test("authoritative activity replaces counts, actions, milestones, and terminal timing", () => {
  let state = createProgressState(0);
  state = applyProgressActivity(state, {
    status: "completed",
    durationMs: 65_000,
    thinkingMs: 12_000,
    toolCalls: 7,
    current: "Complete",
    actions: Array.from({ length: 10 }, (_, i) => `Safe action ${i}`),
    milestones: Array.from({ length: 5 }, (_, i) => ({ finding: `Finding ${i}` })),
  });
  const recap = renderProgressRecap(state, "The requested change is ready.");
  assert.match(recap, /^-# 🔨 7 tools used · 💭 1m 5s\n\nThe requested change is ready\.$/);
  assert.equal(recap.includes("Completed"), false);
  assert.equal(recap.includes("✅"), false);
  assert.ok(recap.length <= 1900);
});

test("recap omits zero thinking and distinguishes abort, error, and timeout", () => {
  for (const [status, expected] of [
    ["aborted", "🛑 **Stopped**"],
    ["error", "⚠️ **Failed**"],
    ["timeout", "⏱️ **Timed out**"],
  ]) {
    const state = finishProgressState(createProgressState(0), status, 9_000);
    const recap = renderProgressRecap(state);
    assert.match(recap, new RegExp(`^${expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.equal(recap.includes("thinking"), false);
    assert.match(recap, /💭 9s/);
  }
});

test("renderer throttles semantic edits and refreshes elapsed at twelve seconds", async () => {
  const clock = fakeClock();
  const edits = [];
  const renderer = createProgressRenderer({
    initialState: createProgressState(0),
    edit: async (options) => edits.push(options),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  renderer.update(gatewayProgress({
    phase: "thinking", status: "running", current: "Thinking", elapsedMs: 0,
    thinkingMs: 0, toolCalls: 0,
  }));
  assert.equal(clock.nextDelay(), 5_000);
  assert.equal(edits.length, 0);

  clock.runNext();
  await flushPromises();
  assert.equal(edits.length, 1);
  assert.deepEqual(edits[0].allowedMentions, { parse: [] });
  assert.equal(clock.nextDelay(), 12_000);

  clock.runNext();
  await flushPromises();
  assert.equal(edits.length, 2);
  assert.match(edits[1].content, /17s/);
});

test("renderer serializes edits, coalesces state, and queues final recap after in-flight edit", async () => {
  const clock = fakeClock();
  const edits = [];
  let releaseFirst;
  const firstEdit = new Promise((resolve) => { releaseFirst = resolve; });
  const renderer = createProgressRenderer({
    initialState: createProgressState(0),
    edit(options) {
      edits.push(options);
      return edits.length === 1 ? firstEdit : Promise.resolve();
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    finalSuffix: "\n\n-# from sandbox:test",
  });

  renderer.update(gatewayProgress({
    phase: "tool", status: "running", current: "Old action", elapsedMs: 1_000,
    thinkingMs: 0, toolCalls: 1,
  }));
  clock.runNext();
  assert.equal(edits.length, 1);

  renderer.update(gatewayProgress({
    phase: "tool", status: "running", current: "Newest action", elapsedMs: 6_000,
    thinkingMs: 2_000, toolCalls: 2, next: "Finish safely",
  }));
  const finalized = renderer.finalize({
    status: "completed",
    durationMs: 8_000,
    thinkingMs: 2_000,
    toolCalls: 2,
    current: "Complete",
    actions: ["Newest action"],
    milestones: [{ next: "Finish safely" }],
  }, "completed", "Here is the result.", { files: ["result.txt"] });
  assert.equal(edits.length, 1, "second edit must wait for first");

  releaseFirst();
  await flushPromises();
  assert.equal(edits.length, 2);
  assert.match(edits[1].content, /^-# 🔨 2 tools used · 💭 8s\n\nHere is the result\./);
  assert.equal(edits[1].content.includes("Completed"), false);
  assert.equal(edits[1].content.includes("✅"), false);
  assert.deepEqual(edits[1].files, ["result.txt"]);
  assert.match(edits[1].content, /-# from sandbox:test$/);
  assert.equal(edits[1].content.includes("Old action"), false);
  assert.deepEqual(edits[1].allowedMentions, { parse: [] });
  await finalized;
  assert.equal(clock.nextDelay(), null);
});

test("renderer failure fallback overrides an earlier completed event", async () => {
  const edits = [];
  const renderer = createProgressRenderer({
    initialState: finishProgressState(createProgressState(0), "completed", 8_000),
    edit: async (options) => edits.push(options),
    now: () => 9_000,
  });

  await renderer.finalize(null, "error");
  assert.match(edits[0].content, /^⚠️ \*\*Failed\*\*/);
  assert.equal(renderer.getState().status, "error");
});

test("renderer discard cancels pending edits", async () => {
  const clock = fakeClock();
  const edits = [];
  const renderer = createProgressRenderer({
    initialState: createProgressState(0),
    edit: async (options) => edits.push(options),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  renderer.update(gatewayProgress({
    phase: "tool", status: "running", current: "Reacting", elapsedMs: 1_000,
    thinkingMs: 0, toolCalls: 1,
  }));
  renderer.discard();
  assert.equal(clock.nextDelay(), null);
  assert.deepEqual(edits, []);
});
