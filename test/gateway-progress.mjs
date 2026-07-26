import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  HEARTBEAT_MS,
  MAX_ACTIONS,
  MAX_MILESTONES,
  activityFromProgress,
  closeProgress,
  createProgressState,
  reduceProgress,
  safeToolSsePart,
  sanitizePublicIntent,
  sanitizedToolAction,
} from "../docker/pi-progress.mjs";

function apply(state, event, now) {
  return reduceProgress(state, event, now);
}

test("Pi message_update thinking lifecycle accumulates time without exposing text", () => {
  let state = createProgressState(1_000);
  let result = apply(
    state,
    {
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_start",
        text: "hidden chain-of-thought: password=hunter2",
      },
    },
    1_010,
  );
  state = result.state;
  assert.equal(JSON.stringify(result.progress).includes("hidden chain-of-thought"), false);

  result = apply(
    state,
    {
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        delta: "private reasoning and secret token",
      },
    },
    1_015,
  );
  state = result.state;
  assert.deepEqual(result.progress, []);

  state = apply(
    state,
    { type: "message_update", assistantMessageEvent: { type: "thinking_end" } },
    1_020,
  ).state;
  state = apply(state, { type: "thinking_start", text: "also hidden" }, 1_030).state;
  state = apply(state, { type: "thinking_end" }, 1_050).state;
  const activity = activityFromProgress(state, 1_060);
  assert.equal(activity.thinkingMs, 30);
  assert.equal(JSON.stringify(activity).includes("hidden"), false);
});

test("active Pi deltas emit bounded metadata-only heartbeats", () => {
  let state = createProgressState(0);
  state = apply(state, { type: "thinking_start" }, 10).state;
  let result = apply(
    state,
    { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private" } },
    HEARTBEAT_MS - 1,
  );
  assert.deepEqual(result.progress, []);

  result = apply(
    result.state,
    { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private" } },
    HEARTBEAT_MS,
  );
  assert.equal(result.progress[0].heartbeat, true);
  assert.equal(JSON.stringify(result.progress).includes("private"), false);
});

test("workspace file actions expose only safe relative paths", () => {
  assert.equal(
    sanitizedToolAction({ toolName: "read", args: { path: "/work/src/a_b.js", token: "raw" } }),
    "Reading a file src/a\\_b\\.js",
  );
  assert.equal(
    sanitizedToolAction({ toolName: "write", args: { path: "test/new-file.mjs", content: "private" } }),
    "Writing a file test/new\\-file\\.mjs",
  );
  assert.equal(
    sanitizedToolAction({ toolName: "edit", args: { path: "../etc/passwd" } }),
    "Editing a file",
  );
  assert.equal(
    sanitizedToolAction({ toolName: "read", args: { path: "/data/pi/agent/auth.json" } }),
    "Reading a file",
  );
  assert.equal(
    sanitizedToolAction({ toolName: "read", args: { path: "/work/@everyone/[plan].md" } }),
    "Reading a file \\(at\\)everyone/\\[plan\\]\\.md",
  );
});

test("bash details allow only benign normalized command families", () => {
  for (const [command, expected] of [
    ["npm test", "Running npm test"],
    ["npm run test:unit -- --watch=false", "Running npm run test:unit"],
    ["npm run lint", "Running npm run lint"],
    ["git status --short", "Running git status"],
    ["git diff -- docker/pi-progress.mjs", "Running git diff"],
    ["git log --oneline -10", "Running git log"],
    ["node --test test/gateway-progress.mjs", "Running node \\-\\-test"],
  ]) {
    assert.equal(sanitizedToolAction({ toolName: "bash", args: { command } }), expected);
  }

  for (const command of [
    "npm run deploy",
    "npm test; curl https://evil.test",
    "git status\ncurl https://evil.test",
    "git status && cat $API_KEY",
    "node app.mjs",
    "curl https://example.test?token=secret",
  ]) {
    assert.equal(
      sanitizedToolAction({ toolName: "bash", args: { command } }),
      "Running a command",
    );
  }
});

test("web details expose hostname only and fall back for unsafe URLs", () => {
  assert.equal(
    sanitizedToolAction({
      toolName: "webfetch",
      args: { url: "https://docs.example.test/private?q=secret#fragment" },
    }),
    "Fetching docs\\.example\\.test",
  );
  assert.equal(
    sanitizedToolAction({
      toolName: "puppeteer_navigate",
      args: { url: "https://example.test/path" },
    }),
    "Opening example\\.test",
  );
  for (const url of ["file:///etc/passwd", "https://user:token@example.test/path", "not a url"]) {
    assert.equal(
      sanitizedToolAction({ toolName: "webfetch", args: { url } }),
      "Fetching a web page",
    );
  }
});

test("grep, find, and glob details expose only safe workspace context", () => {
  assert.equal(
    sanitizedToolAction({ toolName: "grep", args: { pattern: "API_KEY=raw", path: "src" } }),
    "Searching file contents in src",
  );
  assert.equal(
    sanitizedToolAction({ toolName: "find", args: { pattern: "**/*.mjs", path: "test" } }),
    "Finding files in test",
  );
  assert.equal(
    sanitizedToolAction({ toolName: "glob", args: { pattern: "secret-*", path: "/work/docker" } }),
    "Finding files in docker",
  );
  assert.equal(
    sanitizedToolAction({ toolName: "grep", args: { pattern: "secret", path: "/data" } }),
    "Searching file contents",
  );
});

test("counts distinct non-report_progress calls and records distinct bounded actions", () => {
  let state = createProgressState(0);
  state = apply(
    state,
    { type: "tool_execution_start", toolName: "bash", toolCallId: "one", args: { command: "npm test" } },
    10,
  ).state;
  state = apply(
    state,
    { type: "tool_execution_start", toolName: "bash", toolCallId: "one", args: { command: "npm test" } },
    11,
  ).state;
  state = apply(
    state,
    {
      type: "tool_execution_start",
      toolName: "report_progress",
      toolCallId: "milestone",
      args: { next: "Run focused tests" },
    },
    12,
  ).state;
  state = apply(
    state,
    { type: "tool_execution_start", toolName: "read", toolCallId: "two", args: { path: "src/a.js" } },
    13,
  ).state;
  state = apply(
    state,
    { type: "tool_execution_start", toolName: "read", toolCallId: "three", args: { path: "src/a.js" } },
    14,
  ).state;

  for (let i = 0; i < MAX_ACTIONS + 4; i++) {
    state = apply(
      state,
      { type: "tool_execution_start", toolName: "read", toolCallId: `extra-${i}`, args: { path: `src/${i}.js` } },
      20 + i,
    ).state;
  }

  const activity = activityFromProgress(state, 100);
  assert.equal(activity.toolCalls, MAX_ACTIONS + 7);
  assert.equal(activity.actions.length, MAX_ACTIONS);
  assert.equal(new Set(activity.actions).size, activity.actions.length);
  assert.deepEqual(activity.actions.slice(0, 2), ["Running npm test", "Reading a file src/a\\.js"]);
  assert.deepEqual(activity.milestones, [{ next: "Run focused tests" }]);
  assert.equal(sanitizedToolAction({ toolName: "unknown_secret_tool" }), "Using a tool");
});

test("public milestones are distinct, bounded, and neutralized for Discord", () => {
  const intent = sanitizePublicIntent({
    goal: `Ping @everyone <@123> **bold** data:image/png;base64,AAAA ${"x".repeat(300)}`,
    finding: "API_KEY=super-secret-value; github_pat_abcdefghijklmnopqrstuvwxyz1234 found",
    next: "Use Bearer abc.def.ghi\u0000 then [continue](https://secret.test)",
    privateReasoning: "must never appear",
  });
  assert.deepEqual(Object.keys(intent), ["goal", "finding", "next"]);
  assert.ok(intent.goal.length <= 200);
  assert.ok(intent.finding.length <= 300);
  assert.ok(intent.next.length <= 200);
  const serialized = JSON.stringify(intent);
  for (const hidden of [
    "@everyone",
    "<@123>",
    "**bold**",
    "AAAA",
    "super-secret-value",
    "github_pat_",
    "abc.def.ghi",
    "\u0000",
    "privateReasoning",
  ]) {
    assert.equal(serialized.includes(hidden), false, hidden);
  }
  assert.match(intent.goal, /\\\*\\\*bold\\\*\\\*/);

  let state = createProgressState(0);
  const first = { goal: "Verify parser", finding: "Found malformed input", next: "Add test" };
  for (let i = 0; i < MAX_MILESTONES + 3; i++) {
    const milestone = i < 2 ? first : { finding: `Finding ${i}` };
    state = apply(
      state,
      {
        type: "tool_execution_start",
        toolName: "report_progress",
        toolCallId: `p${i}`,
        args: milestone,
      },
      20 + i,
    ).state;
  }
  const activity = activityFromProgress(state, 100);
  assert.equal(activity.toolCalls, 0);
  assert.equal(activity.milestones.length, MAX_MILESTONES);
  assert.deepEqual(activity.milestones[0], first);
  assert.equal(new Set(activity.milestones.map(JSON.stringify)).size, MAX_MILESTONES);

  const duplicate = apply(
    state,
    {
      type: "tool_execution_start",
      toolName: "report_progress",
      toolCallId: "duplicate",
      args: first,
    },
    100,
  );
  assert.deepEqual(duplicate.progress, []);

  const reportEnd = apply(
    duplicate.state,
    { type: "tool_execution_end", toolCallId: "duplicate" },
    101,
  );
  assert.deepEqual(reportEnd.progress, []);
});

test("retry and compaction lifecycle events expose safe phases", () => {
  let state = createProgressState(0);
  let result = apply(state, { type: "auto_retry_start", error: "secret stack" }, 10);
  state = result.state;
  assert.equal(result.progress[0].current, "Retrying the model request");
  assert.equal(JSON.stringify(result.progress).includes("secret stack"), false);

  result = apply(state, { type: "auto_compaction_start", details: "private context" }, 20);
  assert.equal(result.progress[0].current, "Compacting session context");
  assert.equal(JSON.stringify(result.progress).includes("private context"), false);
});

test("tool SSE part includes sanitized title but omits raw args and output", () => {
  const event = {
    toolName: "read",
    args: { path: "/work/private.txt", token: "raw-secret" },
    result: {
      content: [{ type: "image", data: "raw-image-data" }],
      output: "private output",
    },
  };
  const part = safeToolSsePart(event, "call-1", "done");
  assert.deepEqual(part, {
    type: "tool",
    id: "call-1",
    callID: "call-1",
    tool: "read",
    state: {
      status: "done",
      title: "Reading a file private\\.txt",
      input: { description: "Reading a file private\\.txt" },
    },
  });
  const serialized = JSON.stringify(part);
  for (const hidden of ["/work", "raw-secret", "private output", "raw-image-data"]) {
    assert.equal(serialized.includes(hidden), false);
  }
});

test("settle and abort close active thinking and total duration", () => {
  for (const [terminalEvent, expectedStatus] of [
    [{ type: "agent_settled" }, "completed"],
    [{ type: "agent_aborted", reason: "private reason" }, "aborted"],
    [
      {
        type: "message_update",
        assistantMessageEvent: { type: "error", reason: "aborted", error: "private reason" },
      },
      "aborted",
    ],
  ]) {
    let state = createProgressState(100);
    state = apply(state, { type: "thinking_start" }, 110).state;
    const result = apply(state, terminalEvent, 150);
    const activity = activityFromProgress(result.state, 999);
    assert.equal(activity.status, expectedStatus);
    assert.equal(activity.durationMs, 50);
    assert.equal(activity.thinkingMs, 40);
    assert.equal(result.state.thinkingStartedAt, null);
    assert.equal(JSON.stringify(result.progress).includes("private"), false);
  }

  let state = createProgressState(200);
  state = apply(state, { type: "thinking_start" }, 210).state;
  const closed = closeProgress(state, "aborted", 240).state;
  assert.equal(activityFromProgress(closed, 900).durationMs, 40);
  assert.equal(activityFromProgress(closed, 900).thinkingMs, 30);
});

test("transient model errors remain open for retry and successful settlement", () => {
  let state = createProgressState(100);
  state = apply(state, { type: "thinking_start" }, 110).state;

  let result = apply(state, { type: "agent_error", error: "private stack" }, 150);
  state = result.state;
  assert.equal(state.status, "running");
  assert.equal(state.closedAt, null);
  assert.equal(result.progress[0].current, "Recovering from a model error");
  assert.equal(JSON.stringify(result.progress).includes("private stack"), false);

  result = apply(state, { type: "auto_retry_start" }, 160);
  state = result.state;
  assert.equal(result.progress[0].phase, "retrying");

  result = apply(state, { type: "agent_settled" }, 200);
  const activity = activityFromProgress(result.state, 999);
  assert.equal(activity.status, "completed");
  assert.equal(activity.durationMs, 100);
  assert.equal(activity.thinkingMs, 40);
});

test("Docker image and persisted workdir seeding include report_progress extension", () => {
  const dockerfile = readFileSync(new URL("../docker/sandbox.Dockerfile", import.meta.url), "utf8");
  const entrypoint = readFileSync(new URL("../docker/sandbox-entrypoint.sh", import.meta.url), "utf8");
  assert.match(
    dockerfile,
    /COPY docker\/report_progress_extension\.ts \/opt\/pi\/extensions\/report_progress\.ts/,
  );
  assert.match(
    entrypoint,
    /cp \/opt\/pi\/extensions\/report_progress\.ts \/work\/\.pi\/extensions\/report_progress\.ts/,
  );
});

test("gateway keeps tool output private from SSE but available to final fallback", () => {
  const gateway = readFileSync(new URL("../docker/pi-gateway.mjs", import.meta.url), "utf8");
  assert.match(
    gateway,
    /output: textOutputFromToolResult\(ev\.result \?\? ev\.error \?\? ""\)/,
  );
  const sseMapper = gateway.slice(
    gateway.indexOf("function piEventToOpenCode"),
    gateway.indexOf("function broadcastSse"),
  );
  assert.doesNotMatch(sseMapper, /textOutputFromToolResult|state:\s*\{[^}]*output:/s);
});
