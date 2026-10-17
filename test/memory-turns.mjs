import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "punch-memory-turns-"));
process.env.DATA_DIR = dir;
process.env.SANDBOX_MAP = JSON.stringify({ alice: "http://sandbox-test:4096" });
const memory = await import("../src/memory.js");
const { recallForSandbox } = await import("../src/memory-recall.js");
const { runPunchTurn } = await import("../src/punch-turn.js");
const { handleChat } = await import("../src/chat/chat.js");
const { fireRoutine } = await import("../src/chat/routines-fire.js");
const { registry } = await import("../src/core/registry.js");
const state = await import("../src/state.js");
test.after(() => { memory.closeMemory(); rmSync(dir, { recursive: true, force: true }); });

function sandbox(t, fail = false, unavailable = false, taggedOutput = false) {
  const prompts = [];
  const paths = [];
  const contexts = [];
  t.mock.method(globalThis, "fetch", async (input, options = {}) => {
    const url = new URL(String(input));
    paths.push(url.pathname + url.search);
    if (url.pathname === "/env" || url.pathname === "/model") return Response.json({ model: "test/fake" });
    if (url.pathname === "/session") return Response.json({ id: "test-session" });
    if (url.pathname === "/file/content") {
      assert.equal(url.searchParams.get("path"), "/work/.pi/SYSTEM.md", "project memory must not be fetched per turn");
      return Response.json({ type: "text", content: "Test system prompt." });
    }
    if (url.pathname === "/event") return new Response('data: {"type":"server.connected","properties":{}}\n\n', { headers: { "content-type": "text/event-stream" } });
    if (url.pathname === "/session/test-session/message" && options.method === "POST") {
      const prompt = JSON.parse(options.body).parts[0].text;
      prompts.push(prompt);
      const contextId = prompt.match(/memory contextId: ([\w-]+)/)?.[1];
      const output = taggedOutput ? 'Safe answer <remember>likes tea</remember><forget id="old-id"></forget>' : "Safe answer";
      if (taggedOutput && /\((?:heartbeat|scheduled routine)\):/.test(prompt)) {
        return Response.json({ info: { role: "assistant", tokens: {} }, parts: [{ type: "text", text: output }] });
      }
      if (unavailable) {
        assert.match(prompt, /Saved memory is unavailable/);
        assert.equal(contextId, undefined);
        return Response.json({ info: { role: "assistant", tokens: {} }, parts: [{ type: "text", text: output }] });
      }
      assert.ok(contextId);
      contexts.push(contextId);
      assert.match(recallForSandbox({ userId: "alice" }, { query: "aurora", contextId }).text, /Aurora saved preference/);
      assert.match(prompt, /Core profile/);
      assert.match(prompt, /Aurora saved preference/);
      assert.doesNotMatch(prompt, /Recall-only previous project/);
      if (fail) return new Response("agent rejected the turn", { status: 400 });
      return Response.json({ info: { role: "assistant", tokens: {} }, parts: [{ type: "text", text: "Safe answer" }] });
    }
    throw new Error(`Unexpected mocked sandbox request: ${url.pathname}`);
  });
  return { prompts, contexts, paths };
}

test("Spectrum sends the core profile on a no-query turn and revokes recall on success/failure", async (t) => {
  memory.remember("user", "alice", "Aurora saved preference");
  for (let n = 0; n < 6; n++) memory.remember("user", "alice", `Old stable fact ${n}`);
  memory.remember("user", "alice", "Recall-only previous project");
  for (const fail of [false, true]) {
    const mock = sandbox(t, fail);
    const result = await runPunchTurn({ userId: "alice", sessionKey: "spectrum:alice:space", text: "hello" });
    assert.equal(result.ok, !fail);
    assert.equal(mock.prompts.length, 1);
    assert.throws(() => recallForSandbox({ userId: "alice" }, { query: "aurora", contextId: mock.contexts[0] }), (error) => error.status === 403);
    t.mock.restoreAll();
  }
});

test("both turn paths can reply with a disabled memory store after malformed legacy input", async (t) => {
  memory.closeMemory();
  rmSync(join(dir, "memory.sqlite"));
  rmSync(join(dir, "memory.sqlite.cutover"));
  writeFileSync(join(dir, "memory.json"), "{broken legacy");
  assert.equal(memory.initializeMemory({ strict: false }).available, false);
  sandbox(t, false, true, true);
  const result = await runPunchTurn({ userId: "alice", sessionKey: "spectrum:alice:space", text: "hello" });
  assert.equal(result.ok, true);
  assert.equal(result.text, "Safe answer");
  memory.patchUserSettings("alice", { noThinking: true });
  const replies = [];
  await handleChat({ id: "degraded", channelId: "dm", guildId: null, createdTimestamp: Date.now(),
    author: { id: "alice", username: "Alice", bot: false }, attachments: new Map(),
    channel: { sendTyping: async () => {} }, reply: async (payload) => { replies.push(payload.content); return null; },
  }, "hello");
  assert.ok(replies.some((text) => text.includes("Safe answer")));
  assert.ok(replies.some((text) => text.includes("memory update failed (2)")));
  assert.ok(replies.every((text) => !/<remember|<forget|remembered|forgot/.test(text)));
  const deliveries = [];
  const originalClient = registry.client;
  t.after(() => { registry.client = originalClient; });
  const channel = { isTextBased: () => true, send: async (payload) => { deliveries.push(payload.content); } };
  registry.client = { channels: { fetch: async () => channel }, users: { createDM: async () => channel } };
  for (const type of ["heartbeat", "llm"]) {
    await fireRoutine({ id: `disabled-${type}`, type, userId: "alice", channelId: "dm", payload: "Check in" });
    const delivered = deliveries.at(-1);
    assert.match(delivered, /Safe answer/);
    assert.match(delivered, /memory update failed \(2\)/);
    assert.doesNotMatch(delivered, /<remember|<forget|remembered|forgot|Heartbeat error|automation failed/);
    assert.equal(state.getActivities("alice", { limit: 100 }).find((activity) => activity.routineId === `disabled-${type}`).status, "success");
  }
  assert.throws(() => memory.remember("user", "alice", "must not persist"), (error) => error.status === 503);
  // Restore this fixture for the following healthy Discord turn test.
  writeFileSync(join(dir, "memory.json"), JSON.stringify({ users: { alice: [{ id: "restored", text: "Aurora saved preference", ts: Date.now() }] }, channels: {} }));
  assert.throws(() => memory.remember("user", "alice", "still disabled until explicit retry"), (error) => error.status === 503);
  assert.equal(memory.initializeMemory().available, true);
});

test("Discord uses the same recall hint and revokes its context after the turn", async (t) => {
  memory.patchUserSettings("alice", { noThinking: true });
  const mock = sandbox(t);
  const replies = [];
  const message = {
    id: "message", channelId: "dm", guildId: null, createdTimestamp: Date.now(),
    author: { id: "alice", username: "Alice", bot: false }, attachments: new Map(),
    channel: { sendTyping: async () => {} },
    reply: async (payload) => { replies.push(payload.content); return null; },
  };
  await handleChat(message, "hello");
  assert.equal(mock.prompts.length, 1);
  assert.ok(replies.some((text) => text.includes("Safe answer")));
  assert.throws(() => recallForSandbox({ userId: "alice" }, { query: "aurora", contextId: mock.contexts[0] }), (error) => error.status === 403);
});
