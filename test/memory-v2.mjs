import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "punch-memory-v2-"));
process.env.DATA_DIR = dataDir;
const moduleUrl = new URL("../src/memory.js", import.meta.url);
moduleUrl.searchParams.set("test", `${Date.now()}-${Math.random()}`);
const memory = await import(moduleUrl.href);

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

test("preserves remember, list, and forget behavior", () => {
  const entry = memory.remember("user", "basic-user", "  likes tea  ");
  assert.equal(entry.text, "likes tea");
  assert.deepEqual(memory.list("user", "basic-user"), [entry]);
  assert.equal(memory.forget("user", "basic-user", entry.id), true);
  assert.equal(memory.forget("user", "basic-user", entry.id), false);
  assert.deepEqual(memory.list("user", "basic-user"), []);
});

test("keyword search is selective, ranked, cited, and explainable", () => {
  memory.remember("user", "rank-user", "Uses Python for scientific computing");
  memory.remember("user", "rank-user", "Favorite lunch is ramen");
  memory.remember("channel", "rank-channel", "The Python deployment runs on Linux");
  memory.remember("channel", "other-channel", "Python secrets from another channel");

  const results = memory.searchMemory({
    userId: "rank-user",
    channelId: "rank-channel",
    query: "python deployment",
  });
  assert.equal(results[0].scope, "channel");
  assert.match(results[0].citation, /^\[memory:channel:/);
  assert.ok(results.every((result) => /python/i.test(result.text)));
  assert.ok(results.every((result) => !result.text.includes("ramen") && !result.text.includes("another channel")));
  assert.ok(results.every((result) => Number.isFinite(result.score) && result.reason));

  const explained = memory.explainMemory({ userId: "rank-user", channelId: "rank-channel", query: "python" });
  assert.match(explained[0].reason, /^Score /);

  const recent = memory.searchMemory({ userId: "rank-user", channelId: "rank-channel", query: "", limit: 2 });
  assert.equal(recent.length, 2);
});

test("preamble is bounded, cited on every line, and useful with the legacy call", () => {
  const legacy = memory.preamble("rank-user", "rank-channel");
  assert.ok(legacy.length > 0);
  assert.ok(legacy.split("\n").every((line) => /^- \[(?:memory|daily):/.test(line)));

  const bounded = memory.preamble("rank-user", "rank-channel", "python", { maxChars: 85, limit: 10 });
  assert.ok(bounded.length <= 85);
  assert.match(bounded, /^- \[memory:/);
  assert.ok(bounded.split("\n").every((line) => /^- \[memory:(?:user|channel):[^\]]+\]/.test(line)));
});

test("preamble recalls each citation once per Pi session", () => {
  memory.remember("user", "recall-user", "Uses Python for data analysis");
  memory.remember("user", "recall-user", "Uses Python for automation");
  memory.remember("user", "recall-user", "Uses Python for web services");
  memory.remember("user", "recall-user", "Uses Python for testing");

  const options = { recallSessionId: "pi-session-a", maxChars: 1_000, limit: 3 };
  const first = memory.preamble("recall-user", "recall-channel", "python", options);
  const second = memory.preamble("recall-user", "recall-channel", "python", options);
  assert.equal(first.split("\n").length, 3);
  assert.equal(second.split("\n").length, 1);
  assert.ok(second.split("\n").every((line) => !first.includes(line.match(/\[[^\]]+\]/)[0])));

  memory.clearMemoryRecall("pi-session-a");
  assert.equal(memory.preamble("recall-user", "recall-channel", "python", options).split("\n").length, 3);
});

test("pending recall state moves to the new Pi session", () => {
  memory.remember("user", "move-user", "Uses Rust for command-line tools");
  const pending = { recallSessionId: "pending:move-user:channel", maxChars: 1_000, limit: 3 };
  assert.match(memory.preamble("move-user", "move-channel", "rust", pending), /Rust/);
  memory.moveMemoryRecall("pending:move-user:channel", "pi-session-moved");
  assert.equal(memory.preamble("move-user", "move-channel", "rust", {
    recallSessionId: "pi-session-moved", maxChars: 1_000, limit: 3,
  }), "");
});

test("conversation notes are DM-only and isolated from guild retrieval", () => {
  const skipped = memory.captureConversation({
    userId: "dm-user",
    channelId: "dm-channel",
    isDm: false,
    userText: "A guild-only exchange",
    assistantText: "Noted",
  });
  assert.deepEqual(skipped, { notesAdded: 0, factsAdded: 0, facts: [] });

  const captured = memory.captureConversation({
    userId: "dm-user",
    channelId: "dm-channel",
    isDm: true,
    userText: "We discussed the aurora itinerary",
    assistantText: "The aurora plan is ready",
  });
  assert.equal(captured.notesAdded, 1);

  const dmResults = memory.searchMemory({
    userId: "dm-user",
    channelId: "dm-channel",
    query: "aurora",
    isDm: true,
  });
  assert.ok(dmResults.some((result) => result.source === "daily" && /^\[daily:/.test(result.citation)));

  const guildResults = memory.searchMemory({
    userId: "dm-user",
    channelId: "dm-channel",
    query: "aurora",
    isDm: false,
  });
  assert.ok(guildResults.every((result) => result.source !== "daily"));
  assert.doesNotMatch(memory.preamble("dm-user", "dm-channel", "aurora"), /\[daily:/);
  assert.match(memory.preamble("dm-user", "dm-channel", "aurora", { isDm: true }), /\[daily:/);

  const otherDm = memory.searchMemory({
    userId: "dm-user",
    channelId: "different-dm",
    query: "aurora",
    isDm: true,
  });
  assert.ok(otherDm.every((result) => result.source !== "daily"));
});

test("automatic facts are high precision, deduplicated, and secrets are filtered", () => {
  const secret = "sk-supersecretvalue123456";
  const first = memory.captureConversation({
    userId: "facts-user",
    channelId: "facts-dm",
    isDm: true,
    userText: `My name is Ada. I prefer dark mode. remember that my API key is ${secret}.`,
    assistantText: `I will repeat ${secret} but this must not become a durable fact.`,
  });
  assert.equal(first.factsAdded, 2);
  assert.ok(first.facts.some((fact) => /name is Ada/i.test(fact)));
  assert.ok(first.facts.some((fact) => /prefer dark mode/i.test(fact)));
  assert.ok(first.facts.every((fact) => !fact.includes(secret)));
  assert.ok(memory.list("user", "facts-user").every((entry) => !entry.text.includes(secret)));

  const second = memory.captureConversation({
    userId: "facts-user",
    channelId: "facts-dm",
    isDm: true,
    userText: "My name is Ada.",
    assistantText: "Okay",
  });
  assert.equal(second.factsAdded, 0);

  const dailyDir = join(dataDir, "memory");
  const serializedNotes = readdirSync(dailyDir)
    .map((name) => readFileSync(join(dailyDir, name), "utf8"))
    .join("\n");
  assert.ok(!serializedNotes.includes(secret));
  assert.match(serializedNotes, /\[REDACTED\]/);
});

test("portable user-memory export/import preserves facts while rejecting duplicates and foreign data", () => {
  memory.remember("user", "bridge-user", "I prefer concise answers");
  memory.remember("user", "bridge-user", "I prefer concise answers!");
  const exported = memory.exportUserMemory("bridge-user", { source: "punch" });
  assert.equal(exported.format, "punch-memory-v1");
  assert.equal(exported.ownerId, "bridge-user");
  assert.equal(exported.records.length, 1);

  const imported = memory.importUserMemory("import-user", { ...exported, ownerId: "import-user" });
  assert.equal(imported.imported, 1);
  assert.equal(memory.list("user", "import-user").length, 1);

  const repeated = memory.importUserMemory("import-user", { ...exported, ownerId: "import-user" });
  assert.equal(repeated.imported, 0);
  assert.equal(repeated.skipped, 1);

  assert.throws(() => memory.importUserMemory("someone-else", exported), /different Discord user/);
  const sensitive = { ...exported, ownerId: "import-user", records: [{ text: "api key is sk-secret-token-value", ts: Date.now() }] };
  assert.equal(memory.importUserMemory("import-user", sensitive).imported, 0);
});

test("compactMemory removes normalized duplicates and keeps the newest entry", async () => {
  memory.remember("user", "compact-user", "Prefers DARK mode.");
  await new Promise((resolve) => setTimeout(resolve, 2));
  const newestUser = memory.remember("user", "compact-user", " prefers dark mode ");
  memory.remember("channel", "compact-channel", "Deploy on Fridays!");
  await new Promise((resolve) => setTimeout(resolve, 2));
  const newestChannel = memory.remember("channel", "compact-channel", "deploy on fridays");

  const stats = memory.compactMemory({ userId: "compact-user", channelId: "compact-channel" });
  assert.deepEqual(stats, { before: 4, after: 2, removed: 2, userRemoved: 1, channelRemoved: 1 });
  assert.equal(memory.list("user", "compact-user")[0].id, newestUser.id);
  assert.equal(memory.list("channel", "compact-channel")[0].id, newestChannel.id);

  assert.ok(!readdirSync(dataDir).some((name) => name.endsWith(".tmp")));
});

test("user settings include multitaskWorkersCap default", () => {
  const settings = memory.getUserSettings("multitask-user");
  assert.equal(settings.multitaskWorkersCap, 3);
  memory.patchUserSettings("multitask-user", { multitaskWorkersCap: 7 });
  assert.equal(memory.getUserSettings("multitask-user").multitaskWorkersCap, 7);
});
