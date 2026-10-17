import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "punch-recall-"));
process.env.DATA_DIR = dir;
const memory = await import("../src/memory.js");
const { beginMemoryRecall, endMemoryRecall, recallForSandbox } = await import("../src/memory-recall.js");
test.after(() => { memory.closeMemory(); rmSync(dir, { recursive: true, force: true }); });

test("authenticated sandbox identity and bot-created contexts control recall", () => {
  memory.remember("user", "alice", "Aurora user fact");
  memory.remember("user", "bob", "Aurora bob fact");
  memory.remember("channel", "guild", "Aurora channel fact");
  memory.captureConversation({ userId: "alice", channelId: "dm", isDm: true, userText: "Aurora private note", assistantText: "Ready", extractDurableFacts: false });
  const alice = { name: "alice-sandbox", userId: "alice" };
  const bob = { name: "bob-sandbox", userId: "bob" };
  const contextId = beginMemoryRecall("alice", "dm", true);
  const result = recallForSandbox(alice, { query: "aurora", contextId });
  assert.match(result.text, /private note/);
  assert.doesNotMatch(result.text, /bob fact|channel fact/);
  assert.throws(() => recallForSandbox(bob, { query: "aurora", contextId }), (err) => err.status === 403);
  // Caller-supplied identities and channels cannot widen the authorized scope.
  const own = recallForSandbox(alice, { query: "aurora", userId: "bob", channelId: "guild", isDm: true });
  assert.match(own.text, /user fact/);
  assert.doesNotMatch(own.text, /private note|bob fact|channel fact/);
  const guild = beginMemoryRecall("alice", "guild", false);
  assert.match(recallForSandbox(alice, { query: "aurora", contextId: guild }).text, /channel fact/);
  endMemoryRecall(guild);
  endMemoryRecall(contextId);
  assert.throws(() => recallForSandbox(alice, { query: "aurora", contextId }), (err) => err.status === 403);
  assert.throws(() => recallForSandbox(null, { query: "aurora" }), (err) => err.status === 401);
  assert.throws(() => recallForSandbox(alice, { query: "x".repeat(2_001) }), (err) => err.status === 400);
});

test("empty, short, stopword-only, and interior-substring queries do not recall unrelated facts", () => {
  memory.remember("user", "search", "This project is ongoing; going forward with Rust and Next.js, C++ and C#.");
  for (const query of ["", "is", "go", "the and this", "ing", '" OR *']) {
    assert.deepEqual(memory.searchMemory({ userId: "search", query }), [], query);
  }
  for (const query of ["rust", "next.js", "C++", "C#", "ongoi"]) {
    assert.equal(memory.searchMemory({ userId: "search", query }).length, 1, query);
  }
  assert.deepEqual(memory.searchMemory({ userId: "search", query: "rust", limit: 0 }), []);
});

test("fact extraction preserves dotted names, excludes questions, and caps each message at three facts", () => {
  const result = memory.captureConversation({ userId: "facts", channelId: "facts-dm", isDm: true,
    userText: "I use Next.js. I prefer TypeScript. My time zone is Europe/London. Remember that fourth fact. Should I use Python? I use Rust?", assistantText: "Okay" });
  assert.deepEqual(result.facts, ["I use Next.js", "I prefer TypeScript", "My time zone is Europe/London"]);
  const questions = memory.captureConversation({ userId: "questions", channelId: "questions-dm", isDm: true,
    userText: "I use Next.js? Should I prefer Python? Remember that secret?", assistantText: "Let's check" });
  assert.equal(questions.factsAdded, 0);
});

test("recall/preamble budgets cannot exceed the hard cap even if callers request more", () => {
  for (let n = 0; n < 10; n++) memory.remember("user", "budget", `Budget fact ${n} ${"x".repeat(1_000)}`);
  const big = recallForSandbox({ userId: "budget" }, { query: "budget", maxChars: 100_000, limit: 100 }).text;
  assert.ok(big.length > 3_500 && big.length <= 4_000);
  assert.ok(recallForSandbox({ userId: "budget" }, { query: "budget", maxChars: 80 }).text.length <= 80);
});
