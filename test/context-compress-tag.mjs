import assert from "node:assert/strict";
import test from "node:test";
import { extractCompressTag } from "../src/compress-tag.mjs";

test("extractCompressTag detects self-closing tag", () => {
  const { clean, requested } = extractCompressTag("hello <compress /> world");
  assert.equal(requested, true);
  assert.equal(clean, "hello world");
});

test("extractCompressTag detects paired tag", () => {
  const { clean, requested } = extractCompressTag("hello <compress></compress> world");
  assert.equal(requested, true);
  assert.equal(clean, "hello world");
});

test("extractCompressTag detects bare tag", () => {
  const { clean, requested } = extractCompressTag("<compress>");
  assert.equal(requested, true);
  assert.equal(clean, "");
});

test("extractCompressTag is case-insensitive", () => {
  const { clean, requested } = extractCompressTag("<COMPRESS /> stuff");
  assert.equal(requested, true);
  assert.equal(clean, "stuff");
});

test("extractCompressTag no tag", () => {
  const { clean, requested } = extractCompressTag("just a normal message");
  assert.equal(requested, false);
  assert.equal(clean, "just a normal message");
});

test("extractCompressTag null or undefined input", () => {
  assert.equal(extractCompressTag(null).requested, false);
  assert.equal(extractCompressTag(undefined).requested, false);
  assert.equal(extractCompressTag(null).clean, "");
});

test("extractCompressTag multiple tags", () => {
  const { clean, requested } = extractCompressTag("<compress></compress> a <compress /> b");
  assert.equal(requested, true);
  assert.equal(clean, "a b");
});

test("extractCompressTag strips tags from mixed content", () => {
  const { clean, requested } = extractCompressTag("text <compress /> more <compress></compress> end");
  assert.equal(requested, true);
  assert.equal(clean, "text more end");
});

test("extractCompressTag strips paired tags with non-empty content", () => {
  const { clean, requested } = extractCompressTag("before <compress>payload</compress> after");
  assert.equal(requested, true);
  assert.equal(clean, "before payload after");
});
