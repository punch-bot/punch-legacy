import assert from "node:assert/strict";
import test from "node:test";
import {
  activeMessageIds,
  blockPreview,
  createBlock,
  deactivateBlock,
  emptyState,
  messageRecords,
  recompressBlock,
  searchBlocks,
} from "../docker/context-pruning-state.mjs";
import { readFile } from "node:fs/promises";

const records = messageRecords([
  { type: "message", id: "u1", message: { role: "user", content: "first request" } },
  { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "first reply" }] } },
  { type: "message", id: "u2", message: { role: "user", content: "inspect logs" } },
  { type: "message", id: "a2", message: { role: "assistant", content: [{ type: "text", text: "long investigation" }] } },
  { type: "message", id: "t2", message: { role: "toolResult", content: [{ type: "text", text: "large output" }] } },
  { type: "message", id: "u3", message: { role: "user", content: "implement patch" } },
]);

test("creates a reversible block over complete user turns", () => {
  const state = createBlock(emptyState(), records, {
    startId: "u2", endId: "u3", topic: "log investigation", summary: "Found root cause.",
  });
  assert.deepEqual([...activeMessageIds(state)], ["u2", "a2", "t2", "u3"]);
  assert.equal(state.blocks[0].sourceCharacters, 57);
  assert.match(blockPreview(records, state.blocks[0]), /large output/);
  const restored = deactivateBlock(state, "b1");
  assert.equal(activeMessageIds(restored).size, 0);
});

test("protects first user message and overlapping blocks", () => {
  assert.throws(() => createBlock(emptyState(), records, {
    startId: "u1", endId: "u2", summary: "bad",
  }), /protected/);
  const state = createBlock(emptyState(), records, {
    startId: "u2", endId: "u3", summary: "good",
  });
  assert.throws(() => createBlock(state, records, {
    startId: "u2", endId: "u3", summary: "overlap",
  }), /overlaps/);
});

test("searches active summaries without restoring raw context", () => {
  const state = createBlock(emptyState(), records, {
    startId: "u2", endId: "u3", topic: "log investigation", summary: "Root cause was stale cache.",
  });
  assert.equal(searchBlocks(state, "stale cache")[0].block.id, "b1");
  assert.equal(searchBlocks(deactivateBlock(state, "b1"), "stale").length, 0);
});

test("recompresses multiple deactivated T1 blocks into a T2 block", () => {
  const withB1 = createBlock(emptyState(), records, {
    startId: "u2", endId: "u2", topic: "logs", summary: "Inspected server logs.",
  });
  const withB2 = createBlock(withB1, records, {
    startId: "u3", endId: "u3", topic: "patch", summary: "Implemented the fix.",
  });
  const restored = deactivateBlock(deactivateBlock(withB2, "b1"), "b2");
  const recompressed = recompressBlock(restored, ["b1", "b2"], {
    summary: "Investigated logs then applied fix.",
    topic: "log investigation and fix",
  });
  assert.equal(recompressed.blocks.length, 3);
  const t2 = recompressed.blocks[2];
  assert.equal(t2.tier, 2);
  assert.equal(t2.active, true);
  assert.deepEqual(t2.parentBlockIds, ["b1", "b2"]);
  assert.ok(t2.messageIds.includes("u2"));
  assert.ok(t2.messageIds.includes("u3"));
  assert.equal(activeMessageIds(recompressed).size, 2);
});

test("recompress rejects non-existent and active blocks", () => {
  assert.throws(() => recompressBlock(emptyState(), ["b1", "b2"], { summary: "nope" }), /not found/);
  const withB1 = createBlock(emptyState(), records, {
    startId: "u2", endId: "u3", summary: "still active",
  });
  assert.throws(() => recompressBlock(withB1, ["b1"], { summary: "nope" }), /need at least 2/);
  assert.throws(() => recompressBlock(withB1, ["b2", "b3"], { summary: "nope" }), /not found/);
});

test("sandbox image and workdir seeding include context-pruning state", async () => {
  const [dockerfile, entrypoint] = await Promise.all([
    readFile(new URL("../docker/sandbox.Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("../docker/sandbox-entrypoint.sh", import.meta.url), "utf8"),
  ]);
  assert.match(dockerfile, /COPY docker\/context-pruning-state\.mjs \/opt\/pi\/context-pruning-state\.mjs/);
  assert.match(entrypoint, /cp \/opt\/pi\/context-pruning-state\.mjs \/work\/\.pi\/context-pruning-state\.mjs/);
});
