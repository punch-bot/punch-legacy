import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractCompressTag } from "../src/compress-tag.mjs";

describe("extractCompressTag", () => {
  it("returns text untouched when no tag is present (the every-reply path)", () => {
    const text = "para one\n\npara two\n  indented line";
    const { clean, requested } = extractCompressTag(text);
    assert.equal(requested, false);
    // Exact equality: the old bug collapsed \n{2,} to a single space here.
    assert.equal(clean, "para one\n\npara two\n  indented line");
  });

  it("strips the tag and preserves every newline around it", () => {
    const { clean, requested } = extractCompressTag("before\n\n<compress />\n\nafter");
    assert.equal(requested, true);
    // Exact equality: even \n\n -> \n (partial collapse) would be a regression.
    assert.equal(clean, "before\n\n\n\nafter");
  });

  it("strips a paired tag without touching surrounding lines", () => {
    const { clean, requested } = extractCompressTag("before\n<compress>mid</compress>\nafter");
    assert.equal(requested, true);
    assert.equal(clean, "before\nmid\nafter");
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
