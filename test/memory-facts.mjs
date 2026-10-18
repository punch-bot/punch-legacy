import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "punch-facts-"));
process.env.DATA_DIR = dir;
const memory = await import("../src/memory.js");
test.after(() => { memory.closeMemory(); rmSync(dir, { recursive: true, force: true }); });

function capture(userId, userText) {
  return memory.captureConversation({ userId, channelId: `${userId}-dm`, isDm: true, userText, assistantText: "Okay" });
}

test("PNCH-43: dotted names, URLs, and versions survive sentence extraction and restart", () => {
  const result = capture("dotted", "I use Next.js.\tI prefer version 3.14!\nRemember that docs live at https://example.org/docs.");
  const facts = ["I use Next.js", "I prefer version 3.14", "Remember that docs live at https://example.org/docs"];
  assert.deepEqual(result.facts, facts);
  memory.closeMemory();
  assert.deepEqual(memory.list("user", "dotted").map((record) => record.text), facts);
});

test("PNCH-43: ordinary and quoted questions never become durable facts", () => {
  const result = capture("questions", 'Should I use Rust? "I use Next.js?" ‘Remember that draft?’ (I prefer Vim?)\nI use SQLite.');
  assert.deepEqual(result.facts, ["I use SQLite"]);
  assert.deepEqual(memory.list("user", "questions").map((record) => record.text), ["I use SQLite"]);
});

test("PNCH-43: Unicode whitespace separates sentences and questions", () => {
  const result = capture("unicode", "I use Next.js.\u00a0I prefer TypeScript?\u2028My time zone is UTC.");
  assert.deepEqual(result.facts, ["I use Next.js", "My time zone is UTC"]);
});

test("PNCH-43: one message stores at most three unique facts", () => {
  const result = capture("cap", "I use Next.js. I use Next.js. I prefer tea! My name is Ada. Remember that fourth fact.");
  assert.deepEqual(result.facts, ["I use Next.js", "I prefer tea", "My name is Ada"]);
  assert.equal(memory.list("user", "cap").length, 3);
});
