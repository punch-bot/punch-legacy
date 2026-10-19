import assert from "node:assert/strict";
import test from "node:test";
import { chunk, extractReactTags, reply } from "../src/core/discord.js";

test("long replies split under Discord's limit without losing text", () => {
  const text = Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(i % 30)}`).join("\n");
  const parts = chunk(text);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.length <= 1900));
  assert.equal(parts.join(""), text);

  const unbroken = "y".repeat(5000);
  assert.deepEqual(chunk(unbroken).map((part) => part.length), [1900, 1900, 1200]);
  assert.deepEqual(chunk(""), []);
});

test("replies never ping anyone, even when the model writes @everyone", async () => {
  const sent = [];
  const message = { channelId: "c", reply: async (payload) => { sent.push(payload); } };
  await reply(message, "@everyone hello <@123>");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, "@everyone hello <@123>");
  assert.deepEqual(sent[0].allowedMentions, { parse: [] });
});

test("a failed send stops the remaining chunks instead of throwing", async (t) => {
  t.mock.method(console, "error", () => {});
  let calls = 0;
  const message = { channelId: "c", reply: async () => { calls++; throw new Error("Missing Permissions"); } };
  await reply(message, "z".repeat(5000));
  assert.equal(calls, 1);
});

test("react tags are stripped from the reply and collected", () => {
  const { clean, emojis } = extractReactTags('nice <react emoji="🔥"/> work <react emoji="👍">x</react>');
  assert.equal(clean, "nice  work");
  assert.deepEqual(emojis, ["👍", "🔥"]);
});
