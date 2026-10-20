import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activityFromProgress,
  createProgressState as createSandboxState,
  reduceProgress,
} from "../docker/sandbox/usr/local/lib/pi-progress.mjs";
import {
  applyProgressActivity,
  createProgressRenderer,
  createProgressState,
  reduceProgressEvent,
  renderProgressEmbed,
} from "../src/progress-ui.js";

const todoEnd = (id, details, isError = false) => ({
  type: "tool_execution_end",
  toolCallId: id,
  toolName: "todo",
  isError,
  result: { content: [], details },
});

test("sandbox keeps the last todo list from successful todo results", () => {
  let state = createSandboxState(0);
  const ok = reduceProgress(state, todoEnd("a", {
    todos: [{ id: 1, text: "Write tests", done: true }, { id: 2, text: "Ship @everyone", done: false }],
  }), 1);
  state = ok.state;
  assert.deepEqual(ok.progress[0].todos, [
    { text: "Write tests", done: true },
    { text: "Ship \\(at\\)everyone", done: false },
  ]);
  state = reduceProgress(state, todoEnd("b", {}, true), 2).state;
  assert.equal(activityFromProgress(state, 3).todos.length, 2);
  assert.equal(activityFromProgress(createSandboxState(0), 1).todos, undefined);
});

test("bot renders the plan embed live and collapses it on completion", async () => {
  const todos = Array.from({ length: 40 }, (_, i) => ({ text: `Task ${i + 1}`, done: i < 20 }));
  const state = reduceProgressEvent(createProgressState(0), {
    type: "session.progress",
    properties: { phase: "tool", status: "running", current: "Updating the plan", todos },
  });
  const embed = renderProgressEmbed(state);
  assert.equal(embed.title, "📋 Plan · 20/40 done");
  assert.match(embed.description, /^\*17 earlier tasks done\*\n✅ Task 18\n/);
  assert.match(embed.description, /▶️ Task 21\n⬜ Task 22/);
  assert.match(embed.description, /\*8 more tasks\*$/);
  assert.ok(embed.description.length <= 4096);
  assert.equal(renderProgressEmbed(applyProgressActivity(createProgressState(0), { status: "completed" })), null);

  const edits = [];
  const renderer = createProgressRenderer({ initialState: state, edit: (options) => edits.push(options) });
  await renderer.finalize({ status: "completed", todos }, "completed", "Done.");
  assert.deepEqual(edits.at(-1).embeds, []);
  assert.match(edits.at(-1).content, /📋 20\/40 tasks done/);
});
