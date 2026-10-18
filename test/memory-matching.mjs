import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "punch-matching-"));
process.env.DATA_DIR = dir;
const memory = await import("../src/memory.js");
test.after(() => { memory.closeMemory(); rmSync(dir, { recursive: true, force: true }); });

test("PNCH-44: blank, short, and stopword-only queries retrieve neither facts nor daily notes", () => {
  memory.remember("user", "alice", "This ongoing project uses Rust");
  memory.remember("channel", "dm", "Going forward with deployment");
  memory.captureConversation({ userId: "alice", channelId: "dm", isDm: true,
    userText: "This is ongoing planning", assistantText: "We are going forward", extractDurableFacts: false });
  for (const query of ["", " \n\t", "is", "go", "on", "the and this", "who are you", "IS, go!", ".. ?"]) {
    assert.deepEqual(memory.searchMemory({ userId: "alice", channelId: "dm", isDm: true, query }), [], query);
    assert.equal(memory.preamble("alice", "dm", query, { isDm: true }), "", query);
  }
});

test("PNCH-44: only word starts match, including prefixes after normalization and restart", () => {
  memory.remember("user", "prefix", "Configuring deployment with PostgreSQL and Café tools");
  memory.closeMemory();
  for (const query of ["config", "deploy", "postgres", "café", "ＰＯＳＴＧＲＥＳ"]) {
    assert.equal(memory.searchMemory({ userId: "prefix", query }).length, 1, query);
  }
  for (const query of ["figuring", "ployment", "sql", "ools"]) {
    assert.deepEqual(memory.searchMemory({ userId: "prefix", query }), [], query);
  }
});

test("PNCH-44: symbolic language names stay distinct and FTS syntax cannot widen a query", () => {
  memory.remember("user", "languages", "Uses C++ for simulations");
  memory.remember("user", "languages", "Uses C# for applications");
  memory.remember("user", "languages", "Uses Next.js for websites");
  for (const [query, text] of [["C++", "Uses C++ for simulations"], ["C#", "Uses C# for applications"], ["Next.js", "Uses Next.js for websites"]]) {
    assert.deepEqual(memory.searchMemory({ userId: "languages", query }).map((record) => record.text), [text]);
  }
  for (const query of ['" OR *', "NEAR(unrelated)", "search_text:missing", "missing*", "{missing}"]) {
    assert.deepEqual(memory.searchMemory({ userId: "languages", query }), [], query);
  }
});
