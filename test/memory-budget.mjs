import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryBlock } from "../src/prompt-blocks.js";

const dir = mkdtempSync(join(tmpdir(), "punch-budget-"));
process.env.DATA_DIR = dir;
const memory = await import("../src/memory.js");
test.after(() => { memory.closeMemory(); rmSync(dir, { recursive: true, force: true }); });

test("PNCH-45: caller budgets only lower the 4,000-character ceiling including citations and separators", (t) => {
  const logs = [];
  t.mock.method(console, "log", (line) => logs.push(line));
  for (let i = 0; i < 12; i++) memory.remember("user", "budget", `Nebula ${i} ${"private fact ".repeat(100)}`);
  for (const maxChars of [undefined, 100_000, Infinity, 4_000, 100, 1, 0, -10, NaN]) {
    const text = memory.preamble("budget", "dm", "nebula", { maxChars, limit: 100_000 });
    const ceiling = maxChars === undefined ? 3_500 : Math.max(0, Math.min(4_000, maxChars || 0));
    assert.ok(text.length <= ceiling, String(maxChars));
    if (ceiling >= 100) assert.ok(text.length > 0);
    assert.equal(logs.at(-1), `[memory] recall-preamble chars=${text.length} approxTokens=${text.length / 4}`);
  }
  for (const options of [{ limit: 0 }, { maxChars: 0 }, {}]) {
    const text = memory.preamble("budget", "dm", "", options);
    assert.equal(text, "");
    assert.equal(logs.at(-1), "[memory] recall-preamble chars=0 approxTokens=0");
  }
  assert.ok(logs.every((line) => !line.includes("Nebula") && !line.includes("private fact")));
});

test("PNCH-45: actual turn memory logging measures the profile and recall hint without exposing content", (t) => {
  const logs = [];
  t.mock.method(console, "log", (line) => logs.push(line));
  const block = memoryBlock({ contextId: "private-context", profile: "private preference ".repeat(100) });
  assert.equal(logs.at(-1), `[memory] turn-memory-block chars=${block.length} approxTokens=${block.length / 4}`);
  assert.match(block, /Core profile/);
  assert.match(block, /recall_memory/);
  assert.ok(block.length < 1_300);
  assert.ok(logs.every((line) => !line.includes("private-context") && !line.includes("private preference")));
});
