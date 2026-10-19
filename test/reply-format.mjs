import assert from "node:assert/strict";
import test from "node:test";
import { formatReplyNewlines } from "../src/reply-format.js";

test("run-on numbered bold items are split onto their own lines", () => {
  const out = formatReplyNewlines("my list **1. first.** some prose **2. second.** more prose **3. third.** done");
  for (const n of [1, 2, 3]) assert.ok(out.includes(`\n**${n}.`), `item ${n} starts a line`);
});

test("code is never rewritten", () => {
  const fenced = "intro **1. a.**\n```\n**2. not a list item**\n\n\n\nconst x = 1;\n```\n**3. b.** end";
  assert.ok(formatReplyNewlines(fenced).includes("```\n**2. not a list item**\n\n\n\nconst x = 1;\n```"));
  const inline = "run `a **1. b** c` now";
  assert.equal(formatReplyNewlines(inline), inline);
});

test("plain prose, empty, and non-string input pass through safely", () => {
  assert.equal(formatReplyNewlines("just a normal sentence."), "just a normal sentence.");
  assert.equal(formatReplyNewlines(""), "");
  assert.doesNotThrow(() => formatReplyNewlines(null));
  assert.doesNotThrow(() => formatReplyNewlines(undefined));
});
