import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { parse } from "discord-markdown-parser";
import { createProgressRenderer, createProgressState, renderProgressLive, renderProgressRecap } from "../src/progress-ui.js";

const dataDir = mkdtempSync(join(tmpdir(), "punch-discord-delivery-"));
process.env.DATA_DIR = dataDir;
const { registry } = await import("../src/core/registry.js");
const { notifyPigeonDM } = await import("../src/gateway/pigeon.js");
const { extractEmbeds, sendQuestion } = await import("../src/chat/embeds-questions.js");
const { notesFooter } = await import("../src/discord-markdown.js");

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

test("pigeon delivery escapes agent prose and splits messages within Discord's limit", async (t) => {
  const payloads = [];
  const dm = { send: async (payload) => { payloads.push(payload); } };
  const original = registry.client;
  registry.client = { users: { fetch: async () => ({ createDM: async () => dm }) } };
  t.after(() => { registry.client = original; });

  await notifyPigeonDM("recipient", "ember", "scan_slop ".repeat(400));
  assert.ok(payloads.length > 1);
  assert.ok(payloads.every((payload) => payload.content.length <= 1900));
  assert.ok(payloads.map((payload) => payload.content).join("").includes("scan\\_slop"));
  assert.ok(payloads.every((payload) => payload.allowedMentions.parse.length === 0));
});

test("embed markdown is escaped and truncated with closed formatting", () => {
  const { embeds, errors } = extractEmbeds(`<embed>${JSON.stringify({
    description: "scan_slop **formatted**",
    fields: [{ name: "field_name", value: "**" + "x".repeat(1100) + "**" }],
  })}</embed>`);
  assert.deepEqual(errors, []);
  const embed = embeds[0].toJSON();
  assert.equal(embed.description, "scan\\_slop **formatted**");
  assert.equal(embed.fields[0].name, "field\\_name");
  assert.ok(embed.fields[0].value.length <= 1024);
  assert.equal(parse(embed.fields[0].value, "extended")[0].type, "strong");
});

test("question descriptions use the same Discord formatting protection", async (t) => {
  const payloads = [];
  const channel = { send: async (payload) => {
    payloads.push(payload);
    return { id: "question-message", edit: async () => {} };
  } };
  t.after(() => registry.questionState.delete("question-message"));

  await sendQuestion(channel, { title: "Choose", description: "scan_slop **formatted**", options: ["A", "B"] }, "user");
  assert.equal(payloads[0].embeds[0].toJSON().description, "scan\\_slop **formatted**");
});

test("malformed embed error snippets cannot break the notes footer", () => {
  const { errors } = extractEmbeds("<embed>[_a_ *b* ]</embed>");
  assert.equal(errors.length, 1);
  const nodes = parse(notesFooter(errors), "extended");
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].type, "em");
});

test("progress renderers escape stray delimiters in agent-provided fields", () => {
  const state = { ...createProgressState(0), current: "Reading scan_slop", goal: "Fix a_b", actions: ["Read a_b"], milestones: [{ finding: "Found c_d" }] };
  const live = renderProgressLive(state, 1000);
  assert.ok(live.includes("scan\\_slop"));
  assert.ok(live.includes("a\\_b"));
  assert.ok(!parse(live, "extended").some((node) => node.type === "em"));
  const recap = renderProgressRecap({ ...state, status: "error" });
  assert.ok(recap.includes("a\\_b"));
  assert.ok(recap.includes("c\\_d"));
});

test("final recap truncation leaves formatting closed before the sandbox label", async () => {
  const edits = [];
  const renderer = createProgressRenderer({
    initialState: { ...createProgressState(0), actions: ["`" + "a".repeat(130) + "`"] },
    edit: async (options) => edits.push(options),
    now: () => 1000,
    finalSuffix: "\n\n-# from sandbox:" + "x".repeat(63),
  });
  await renderer.finalize(null, "error", "**" + "x".repeat(1646) + "**");
  const content = edits[0].content;
  const nodes = parse(content, "extended");
  assert.ok(content.length <= 1900);
  assert.ok(nodes.some((node) => node.type === "strong" && node.content[0].content === "x".repeat(1646)));
  assert.ok(!nodes.some((node) => node.type === "text" && node.content.includes("`")));
  assert.equal(nodes.at(-1).type, "subtext");
});
