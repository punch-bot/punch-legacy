import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractCompressTag } from "../src/compress-tag.mjs";

describe("extractCompressTag", () => {
  it("preserves newlines when no tag is present (the every-reply path)", () => {
    const text = "para one\n\npara two\n  indented line";
    const { clean, requested } = extractCompressTag(text);
    assert.equal(requested, false);
    assert.equal(clean, text.trim());
    assert.equal((clean.match(/\n/g) || []).length, 3);
  });

  it("keeps newlines when stripping a tag", () => {
    const text = "before\n\n<compress />\n\nafter";
    const { clean, requested } = extractCompressTag(text);
    assert.equal(requested, true);
    assert.ok(clean.includes("before"));
    assert.ok(clean.includes("after"));
    assert.ok((clean.match(/\n/g) || []).length >= 1, "newlines must survive tag strip");
    assert.ok(!clean.includes("<compress"));
  });

  it("still collapses runs of spaces/tabs (not newlines)", () => {
    const { clean } = extractCompressTag("<compress>  a     b\t\tc  </compress>");
    assert.equal(clean, "a b c");
  });

  it("detects the bare tag form", () => {
    const { requested } = extractCompressTag("hello <compress> world");
    assert.equal(requested, true);
  });
});
