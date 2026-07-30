import assert from "node:assert/strict";
import test from "node:test";
import {
  STATE_VERSION,
  STATE_TYPE,
  activeBlocks,
  activeMessageIds,
  blockPreview,
  createBlock,
  deactivateBlock,
  emptyState,
  MAX_SUMMARY_CHARS,
  messageRecords,
  normalizeState,
  recompressBlock,
  searchBlocks,
  textFromContent,
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

const protectedRecords = messageRecords([
  { type: "message", id: "u0", message: { role: "user", content: "hello" } },
  { type: "message", id: "a0", message: { role: "assistant", content: "hi" } },
  { type: "message", id: "u1", message: { role: "user", content: "compress old stuff" } },
  { type: "message", id: "a1", message: { role: "assistant", toolName: "compress_context", content: "should not be compressed" } },
  { type: "message", id: "u2", message: { role: "user", content: "next request" } },
]);

test("quality gate rejects placeholder summaries", () => {
  assert.throws(() => createBlock(emptyState(), records, {
    startId: "u2", endId: "u3", summary: "...",
  }), /too vague/);
});

test("quality gate enforces ratio for ranges >= 500 chars", () => {
  const bigContent = "x".repeat(200);
  const bigRecords = messageRecords([
    { type: "message", id: "u0", message: { role: "user", content: "hi" } },
    { type: "message", id: "a0", message: { role: "assistant", content: "hey" } },
    { type: "message", id: "u2", message: { role: "user", content: bigContent } },
    { type: "message", id: "a2", message: { role: "assistant", content: bigContent } },
    { type: "message", id: "u3", message: { role: "user", content: bigContent } },
  ]);
  assert.throws(() => createBlock(emptyState(), bigRecords, {
    startId: "u2", endId: "u3", summary: "too short",
  }), /too short/);
  const valid = createBlock(emptyState(), bigRecords, {
    startId: "u2", endId: "u3", summary: "long enough summary that exceeds the minimum ratio requirement for quality check purposes",
  });
  assert.ok(valid.blocks[0].summary);
});

test("blocks creation over range containing protected tool output", () => {
  assert.throws(() => createBlock(emptyState(), protectedRecords, {
    startId: "u1", endId: "u2", summary: "bad",
  }), /protected tool/);
});

test("recompress rejects non-existent and active blocks", () => {
  assert.throws(() => recompressBlock(emptyState(), ["b1", "b2"], { summary: "nope" }), /not found/);
  const withB1 = createBlock(emptyState(), records, {
    startId: "u2", endId: "u3", summary: "still active",
  });
  assert.throws(() => recompressBlock(withB1, ["b1"], { summary: "nope" }), /need at least 2/);
  assert.throws(() => recompressBlock(withB1, ["b2", "b3"], { summary: "nope" }), /not found/);
});

test("normalizeState recovers from corrupted data", () => {
  assert.deepEqual(normalizeState(null), emptyState());
  assert.deepEqual(normalizeState(undefined), emptyState());
  assert.deepEqual(normalizeState({}), emptyState());
  assert.deepEqual(normalizeState({ version: 999, blocks: [] }), emptyState());
  assert.deepEqual(normalizeState({ version: STATE_VERSION, blocks: "corrupted" }), emptyState());
  const withBad = normalizeState({ version: STATE_VERSION, nextBlockId: -5, blocks: [{ id: "b1", messageIds: ["u2"], summary: "ok" }] });
  assert.equal(withBad.nextBlockId, 2);
  assert.equal(withBad.blocks.length, 1);
  const filtered = normalizeState({ version: STATE_VERSION, blocks: [{ id: "b1", messageIds: "not-array", summary: "bad" }, { id: "b2", messageIds: ["u2"], summary: "good" }] });
  assert.equal(filtered.blocks.length, 1);
  assert.equal(filtered.blocks[0].id, "b2");
});

test("emptyState has correct defaults", () => {
  const s = emptyState();
  assert.equal(s.version, STATE_VERSION);
  assert.equal(s.nextBlockId, 1);
  assert.deepEqual(s.blocks, []);
});

test("textFromContent handles various input types", () => {
  assert.equal(textFromContent("plain"), "plain");
  assert.equal(textFromContent([{ type: "text", text: "first" }, { type: "image" }, { type: "text", text: "second" }]), "first\nsecond");
  assert.equal(textFromContent([{ type: "image", source: "x" }]), "");
  assert.equal(textFromContent(123), "");
  assert.equal(textFromContent(null), "");
  assert.equal(textFromContent(undefined), "");
});

test("messageRecords filters non-message entries", () => {
  const records = messageRecords([
    { type: "message", id: "m1", message: { role: "user", content: "hi" } },
    { type: "custom", id: "c1", data: { something: true } },
    { type: "message", id: null, message: { role: "user" } },
    { id: "no-type" },
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, "m1");
});

test("blockPreview handles empty and edge records", () => {
  assert.equal(blockPreview([], { messageIds: ["x"] }), "[No text content in this range]");
  const recs = [
    { id: "m1", message: { role: "user", content: "hello" } },
    { id: "m2", message: { role: "assistant", content: [{ type: "text", text: "world" }] } },
  ];
  const preview = blockPreview(recs, { messageIds: ["m1", "m2"] });
  assert.match(preview, /hello/);
  assert.match(preview, /world/);
});

test("searchBlocks handles empty query or no matches", () => {
  const state = createBlock(emptyState(), records, {
    startId: "u2", endId: "u3", summary: "Found root cause.",
  });
  assert.deepEqual(searchBlocks(state, ""), []);
  assert.deepEqual(searchBlocks(state, "nonexistent"), []);
  assert.equal(activeBlocks(deactivateBlock(state, "b1")).length, 0);
});

test("createBlock rejects summaries exceeding MAX_SUMMARY_CHARS", () => {
  const hugeSummary = "x".repeat(MAX_SUMMARY_CHARS + 1);
  assert.throws(() => createBlock(emptyState(), records, {
    startId: "u2", endId: "u3", summary: hugeSummary,
  }), /exceeds/);
});

test("deactivateBlock rejects non-existent block id", () => {
  assert.throws(() => deactivateBlock(emptyState(), "b99"), /not found/);
});

test("sandbox image and workdir seeding include context-pruning state and memory", async () => {
  const [dockerfile, entrypoint] = await Promise.all([
    readFile(new URL("../docker/sandbox.Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("../docker/sandbox-entrypoint.sh", import.meta.url), "utf8"),
  ]);
  assert.match(dockerfile, /COPY docker\/context-pruning-state\.mjs \/opt\/pi\/context-pruning-state\.mjs/);
  assert.match(dockerfile, /COPY docker\/compress_context_extension\.ts \/opt\/pi\/extensions\/compress_context\.ts/);
  assert.match(entrypoint, /cp \/opt\/pi\/context-pruning-state\.mjs \/work\/\.pi\/context-pruning-state\.mjs/);
  assert.match(entrypoint, /cp \/opt\/pi\/extensions\/compress_context\.ts \/work\/\.pi\/extensions\/compress_context\.ts/);
  assert.match(entrypoint, /punch-memory\.md/);
  assert.match(entrypoint, /## Guidelines/);
  assert.match(entrypoint, /## Open work/);
});
