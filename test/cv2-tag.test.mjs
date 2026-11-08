// Tests for the <cv2> Components V2 tag parser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractV2 } from "../src/chat/embeds-questions.js";

test("extractV2 parses a spec block and strips it from text", () => {
  const spec = [
    { type: "text", content: "# Punch rocks" },
    { type: "separator", spacing: 1 },
    { type: "buttons", title: "pick", options: ["yes", "no"] },
  ];
  const inText = `before\n<cv2 accent="#ff4f4f">${JSON.stringify(spec)}</cv2>\nafter`;
  const { clean, v2, errors } = extractV2(inText);
  assert.equal(errors.length, 0);
  assert.equal(v2.length, 1);
  assert.equal(v2[0].accent, "#ff4f4f");
  assert.equal(v2[0].items.length, 3);
  assert.equal(clean.trim(), "before\n\nafter"); // tag replacement leaves one blank line, formatReplyNewlines squashes it later
});

test("extractV2 accepts {components:[...]} objects and bare arrays", () => {
  const wrap = JSON.stringify({ accent: "#00ffee", components: [{ type: "text", content: "x" }] });
  const r1 = extractV2(`<cv2>${wrap}</cv2>`);
  assert.equal(r1.v2.length, 1);
  assert.equal(r1.v2[0].items.length, 1);
  assert.equal(r1.v2[0].accent, "#00ffee");
  const bare = JSON.stringify([{ type: "text", content: "y" }]);
  const r2 = extractV2(`<cv2>${bare}</cv2>`);
  assert.equal(r2.v2.length, 1);
  assert.equal(r2.v2[0].accent, "");
});

test("extractV2 reports invalid JSON as errors and drops the tag", () => {
  const r = extractV2("<cv2>{not json}</cv2>");
  assert.equal(r.v2.length, 0);
  assert.ok(r.errors[0].startsWith("cv2 JSON error"));
});

test("extractV2 ignores empty specs", () => {
  const r = extractV2('<cv2 accent="#ff4f4f">[]</cv2>');
  assert.equal(r.v2.length, 0);
  assert.equal(r.errors.length, 0);
  assert.equal(r.clean.trim(), "");
});

test("extractV2 leaves <embed>/<question> tags untouched for other extractors", () => {
  const inText =
    "<embed>{\"title\":\"t\"}</embed>\n<cv2>[{\"type\":\"text\",\"content\":\"c\"}]</cv2>\n<question>opt</question>";
  const { clean, v2 } = extractV2(inText);
  assert.equal(v2.length, 1);
  assert.ok(clean.includes("<embed>"));
  assert.ok(clean.includes("<question>"));
});
