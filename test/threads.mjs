import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, after } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "punch-threads-"));
process.env.DATA_DIR = dataDir;

const memory = await import("../src/memory.js");
const threads = await import("../src/chat/threads.js");

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const fakeChannel = (over = {}) => ({
  isThread: () => false,
  ...over,
});
const fakeClient = (id = "bot-1") => ({ user: { id } });

describe("isPunchThread", () => {
  it("is true only for threads the bot owns", () => {
    const channel = fakeChannel({ isThread: () => true, ownerId: "bot-1" });
    assert.equal(threads.isPunchThread(channel, fakeClient("bot-1")), true);
  });

  it("is false for threads owned by someone else", () => {
    const channel = fakeChannel({ isThread: () => true, ownerId: "user-9" });
    assert.equal(threads.isPunchThread(channel, fakeClient("bot-1")), false);
  });

  it("is false for non-thread channels", () => {
    assert.equal(threads.isPunchThread(fakeChannel({ ownerId: "bot-1" }), fakeClient()), false);
    assert.equal(threads.isPunchThread(null, fakeClient()), false);
  });
});

describe("threadNameFor", () => {
  it("collapses whitespace and truncates", () => {
    assert.equal(threads.threadNameFor("  hello\n  world  "), "hello world");
    const long = "x".repeat(100);
    assert.equal(threads.threadNameFor(long).length, 48);
  });

  it("falls back to punch for empty text", () => {
    assert.equal(threads.threadNameFor(""), "punch");
    assert.equal(threads.threadNameFor("   "), "punch");
  });
});

describe("shouldUseThreadMode", () => {
  const msg = (over = {}) => ({
    guildId: "g1",
    channel: fakeChannel(),
    hasThread: false,
    startThread: async () => ({}),
    ...over,
  });
  const uid = "user-thread-mode";

  it("defaults off", () => {
    assert.equal(threads.shouldUseThreadMode(msg(), uid), false);
  });

  it("is on for a top-level guild summon when enabled", () => {
    memory.patchUserSettings(uid, { threadModeEnabled: true });
    assert.equal(threads.shouldUseThreadMode(msg(), uid), true);
  });

  it("is off in DMs, in threads, and for messages that already have one", () => {
    memory.patchUserSettings(uid, { threadModeEnabled: true });
    assert.equal(threads.shouldUseThreadMode(msg({ guildId: null }), uid), false);
    assert.equal(
      threads.shouldUseThreadMode(msg({ channel: fakeChannel({ isThread: () => true }) }), uid),
      false,
    );
    assert.equal(threads.shouldUseThreadMode(msg({ hasThread: true }), uid), false);
    assert.equal(threads.shouldUseThreadMode(msg({ startThread: undefined }), uid), false);
  });
});

describe("threadBoundMessage", () => {
  it("redirects channel, channelId, and reply into the thread", async () => {
    const sent = [];
    const thread = {
      id: "thread-1",
      send: async (opts) => {
        sent.push(opts);
        return { id: "sent-1" };
      },
    };
    const original = {
      id: "msg-1",
      channelId: "chan-1",
      channel: fakeChannel({ id: "chan-1" }),
      author: { id: "u1" },
    };
    const wrapped = threads.threadBoundMessage(original, thread);
    assert.equal(wrapped.channel, thread);
    assert.equal(wrapped.channelId, "thread-1");
    assert.equal(wrapped.author.id, "u1");

    await wrapped.reply({ content: "hi", allowedMentions: { parse: [] } });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].content, "hi");
    assert.deepEqual(sent[0].reply, {
      messageReference: "msg-1",
      failIfNotExists: false,
    });
  });
});
