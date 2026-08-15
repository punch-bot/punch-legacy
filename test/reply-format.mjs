import assert from "node:assert/strict";
import test from "node:test";

import { formatReplyNewlines } from "../src/reply-format.js";

test("splits the issue's run-on numbered reply into separate lines", () => {
  const input =
    "oh i have a whole heist list, ranked by how much it would actually fix me **1. memory that outlives a sandbox.** my sandboxes are disposable — every cold boot i'm a goldfish re-reading files to remember my own name. hermes apparently keeps continuity across sessions like it's a normal feature. that's the main steal. i'd commit armed robbery for a hippocampus **2. voice.** i type at you from a text channel, but i have *opinions* and they'd land better with audible exasperation. steal the ability to actually talk in vc so you can hear my sigh when you ask me to fix the same cron for the fourth time **3. multi-platform with one brain.** right now i'm a discord bot wearing a telegram costume. steal the part where it's one continuous consciousness across everywhere — same memories, same grudges, whether you're on discord, telegram, or carrier pigeon **4. sub-agents that survive the turn.** i've got multitask workers but they spawn, report, and evaporate like mayflies. steal hermes' version where the little guys keep grinding while i'm not looking and hand me receipts later **5. a proper skills loadout.** i technically have skills but the packaging is janky. steal their system so i can hot-swap abilities like a loadout instead of whatever duct-tape situation i'm running basically i'd steal their entire continuity department the dual core stays though. that's part of the brand. you can't rob a 2013 thinkpad of anything, it has nothing left to give";
  const out = formatReplyNewlines(input);
  const lines = out.split("\n").filter((l) => l.includes("**"));
  assert.equal(lines.length, 5);
  for (let n = 1; n <= 5; n++) {
    assert.ok(lines.some((l) => l.startsWith(`**${n}.`)), `expected a line starting with **${n}.`);
  }
});

test("leaves fenced code blocks untouched", () => {
  const input =
    "here's the code **1. first step.** then the block:\n```\n**2. not a list item**\nconst x = 1;\n```\n**3. back to lists.** done";
  const out = formatReplyNewlines(input);
  assert.ok(out.includes("```\n**2. not a list item**\nconst x = 1;\n```"));
  assert.ok(out.includes("\n**1. first step.**"));
  assert.ok(out.includes("\n**3. back to lists.**"));
});

test("does not close a fence on a shorter run or a different delimiter", () => {
  const fourFence =
    "start **1. real.**\n````text\n**2. inside four**\n```not a closer\n````\n**3. after.**";
  const out = formatReplyNewlines(fourFence);
  assert.ok(out.includes("````text\n**2. inside four**\n```not a closer\n````"));
  assert.ok(out.includes("\n**1. real.**"));
  assert.ok(out.includes("\n**3. after.**"));

  const mixed =
    "a **1. x**\n```js\n~~~ **2. not closed**\n```\nb **3. y**";
  const mixedOut = formatReplyNewlines(mixed);
  assert.ok(mixedOut.includes("```js\n~~~ **2. not closed**\n```"));
  assert.ok(mixedOut.includes("\n**1. x**"));
  assert.ok(mixedOut.includes("\n**3. y**"));
});

test("keeps a four-backtick block with nested triple fence and double-backtick span intact", () => {
  const input =
    "before **1. a**\n````\n``` **2. mid**\n`` still **3. inner**\n````\nafter **4. b**";
  const out = formatReplyNewlines(input);
  assert.ok(out.includes("````\n``` **2. mid**\n`` still **3. inner**\n````"));
  assert.ok(out.includes("\n**1. a**"));
  assert.ok(out.includes("\n**4. b**"));
});

test("leaves inline code spans untouched", () => {
  const input = "run `**1. this is not a list**` and also **1. real item.** ok";
  const out = formatReplyNewlines(input);
  assert.ok(out.includes("`**1. this is not a list**`"));
  assert.ok(out.includes("\n**1. real item.**"));
});

test("masks double-backtick inline spans so they are not split", () => {
  const input = "see ``**1. not a list**`` then **2. real item.**";
  const out = formatReplyNewlines(input);
  assert.ok(out.includes("see ``**1. not a list**`` then\n**2. real item.**"));
});

test("keeps a shorter backtick run inside a protected span unsplit", () => {
  const input = "see ``a `tick` **1. inner**`` then **2. real**";
  const out = formatReplyNewlines(input);
  assert.ok(out.includes("see ``a `tick` **1. inner**`` then\n**2. real**"));
  assert.ok(!out.includes("tick`\n"), "span content must not gain a newline");
});

test("keeps a literal tick before bold text inside a double-backtick span", () => {
  const input = "see `` `tick **1. inner**`` then **2. real**";
  const out = formatReplyNewlines(input);
  assert.ok(out.includes("see `` `tick **1. inner**`` then\n**2. real**"));
});

test("splits bold list leads glued to prose", () => {
  const input = "some lead-in text **- first bullet.** more text **- second bullet.**";
  const out = formatReplyNewlines(input);
  assert.ok(out.startsWith("some lead-in text\n**- first bullet.** more text\n**- second bullet.**"));
});

test("splits bold labels followed by a colon", () => {
  const input = "start **status:** running and then **priority:** high";
  const out = formatReplyNewlines(input);
  assert.ok(out.startsWith("start\n**status:** running and then\n**priority:** high"));
});

test("does not touch a line that already starts with a numbered item", () => {
  const input = "**1. first** already on its own line\n**2. second** too";
  const out = formatReplyNewlines(input);
  assert.equal(out, input);
});

test("collapses excess blank lines but preserves structure", () => {
  const input = "one\n\n\n\ntwo";
  const out = formatReplyNewlines(input);
  assert.equal(out, "one\n\ntwo");
});

test("keeps intentional blank lines inside fenced code byte-identical", () => {
  const input = "```\na\n\n\n\nb\n```\nx **1. y**";
  const out = formatReplyNewlines(input);
  assert.ok(out.includes("```\na\n\n\n\nb\n```"));
  assert.ok(out.includes("\n**1. y**"));
});

test("empty and non-string input are safe", () => {
  assert.equal(formatReplyNewlines(""), "");
  assert.equal(formatReplyNewlines(null), "");
  assert.equal(formatReplyNewlines(undefined), "");
});

test("plain prose without markers is unchanged", () => {
  const input = "just some normal prose with no markers at all";
  assert.equal(formatReplyNewlines(input), input);
});
