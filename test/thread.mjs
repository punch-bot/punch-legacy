import { test } from "node:test";
import assert from "node:assert/strict";
import { filterThreadSubtree } from "../src/thread-context.js";

// Helper to build a minimal message shape for the pure filter.
const m = (id, referenceMessageId = null) => ({ id, referenceMessageId });

test("keeps root and a single branch", () => {
  // R <- A <- B
  const msgs = [m("A", "R"), m("B", "A")];
  const keep = filterThreadSubtree(msgs, "R");
  assert.ok(keep.has("R"), "root always kept");
  assert.ok(keep.has("A"));
  assert.ok(keep.has("B"));
});

test("excludes a sibling branch rooted elsewhere", () => {
  // R <- A      S <- X   (X is a different thread)
  const msgs = [m("A", "R"), m("X", "S")];
  const keep = filterThreadSubtree(msgs, "R");
  assert.ok(keep.has("R"));
  assert.ok(keep.has("A"));
  assert.ok(!keep.has("X"), "sibling thread excluded");
  assert.ok(!keep.has("S"));
});

test("keeps a message that reaches root via a long chain", () => {
  // R <- n1 <- n2 <- n3 <- leaf
  const msgs = [m("n1", "R"), m("n2", "n1"), m("n3", "n2"), m("leaf", "n3")];
  const keep = filterThreadSubtree(msgs, "R");
  assert.ok(keep.has("leaf"));
  assert.ok(keep.has("n1") && keep.has("n2") && keep.has("n3"));
});

test("drops a message whose chain leaves the window (parent unknown)", () => {
  // orphan references a parent not in the set -> cannot prove it reaches root
  const msgs = [m("orphan", "missing-parent")];
  const keep = filterThreadSubtree(msgs, "R");
  assert.ok(keep.has("R"));
  assert.ok(!keep.has("orphan"), "orphan with unknown parent is dropped");
});

test("does not loop on a cyclic reference", () => {
  // A <-> B (cycle), root is R; neither reaches R
  const msgs = [m("A", "B"), m("B", "A")];
  const keep = filterThreadSubtree(msgs, "R");
  assert.ok(keep.has("R"));
  assert.ok(!keep.has("A"));
  assert.ok(!keep.has("B"));
});

test("messages in the set but never referencing anyone are excluded", () => {
  const msgs = [m("Z"), m("Y")];
  const keep = filterThreadSubtree(msgs, "R");
  assert.ok(keep.has("R"));
  assert.ok(!keep.has("Z"));
  assert.ok(!keep.has("Y"));
});

test("handles duplicate ids without throwing", () => {
  const msgs = [m("A", "R"), m("A", "R")];
  const keep = filterThreadSubtree(msgs, "R");
  assert.ok(keep.has("A"));
  assert.equal(keep.size, 2); // R + A
});
