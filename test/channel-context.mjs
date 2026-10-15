import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_CONTENT_CHARS,
  fetchChannelContext,
  mapContextMessage,
  readableDiscordContent,
  selectChannelContext,
} from "../src/channel-context.js";

function message(id, authorId, createdTimestamp, content, options = {}) {
  return {
    id,
    author: { id: authorId, username: options.username || `user${authorId}`, bot: !!options.bot },
    member: options.displayName ? { displayName: options.displayName } : null,
    createdTimestamp,
    content,
  };
}

test("selects the newest relevant messages after filtering and orders them by send time", () => {
  const now = Date.parse("2026-09-28T18:40:00Z");
  const others = Array.from({ length: 18 }, (_, i) => message(`other${i}`, "other", now + i * 1000, "not my job"));
  const own = message("own", "alice", now - 2000, "Is Thursday good?", { username: "alice", displayName: "Alice" });
  const referenced = message("reply", "bob", now - 1000, "6 pm works", { username: "bobby", displayName: "Bob" });
  const result = selectChannelContext([...others, referenced, own], {
    userId: "alice",
    referencedIds: new Set(["reply"]),
    timeZone: "UTC",
  });
  assert.deepEqual(result.map((entry) => entry.id), ["own", "reply"]);
  assert.equal(result[1].author, "Bob");
  assert.equal(result[1].username, "bobby");
  assert.equal(result[1].userId, "bob");
  assert.equal(result[1].sentAt, "2026-09-28 18:39 UTC");
});

test("fetches a 100-message window and retrieves older reply and link targets", async () => {
  const now = Date.parse("2026-09-28T18:40:00Z");
  const own = message("200", "alice", now, "current discussion");
  const linked = message("101", "bob", now - 2000, "linked detail");
  const replied = message("102", "carol", now - 1000, "reply detail");
  const summon = message("300", "alice", now + 1000, "See https://discord.com/channels/1/2/101");
  summon.reference = { messageId: "102" };
  const calls = [];
  const channel = {
    messages: {
      async fetch(arg) {
        calls.push(arg);
        if (typeof arg === "object") return new Map([[own.id, own]]);
        if (arg === linked.id) return linked;
        if (arg === replied.id) return replied;
        throw new Error(`unexpected message ${arg}`);
      },
    },
  };

  const result = await fetchChannelContext(channel, summon, { userId: "alice", timeZone: "UTC" });
  assert.deepEqual(calls[0], { limit: 100, before: "300" });
  assert.deepEqual(new Set(calls.slice(1)), new Set(["101", "102"]));
  assert.equal(calls.length, 3);
  assert.deepEqual(result.map((entry) => entry.id), ["101", "102", "200"]);
});

test("truncates long context visibly and suppresses the user's own Punch output", () => {
  const now = Date.parse("2026-09-28T18:40:00Z");
  const long = mapContextMessage(message("long", "alice", now, "x".repeat(800)));
  assert.equal(long.content.length, CONTEXT_CONTENT_CHARS);
  assert.ok(long.content.endsWith("…"));

  const ownPunch = message("bot1", "punch", now, "Done\n\n-# from sandbox:ember", { bot: true });
  const otherPunch = message("bot2", "punch", now, "Ready\n\n-# from sandbox:birch", { bot: true });
  assert.equal(mapContextMessage(ownPunch, "ember"), null);
  assert.deepEqual(
    selectChannelContext([ownPunch, otherPunch], {
      userId: "alice",
      referencedIds: new Set(["bot1", "bot2"]),
      currentSandboxName: "ember",
    }).map((entry) => [entry.author, entry.content]),
    [["punch:birch", "Ready"]],
  );
});

test("keeps an explicit older reference within a full context window", () => {
  const now = Date.parse("2026-09-28T18:40:00Z");
  const own = Array.from({ length: 20 }, (_, i) => message(`own${i}`, "alice", now + i * 60000, `message ${i}`));
  const reference = message("reference", "bob", now - 60000, "earlier answer");
  const result = selectChannelContext([...own, reference], {
    userId: "alice",
    referencedIds: new Set(["reference"]),
    timeZone: "America/New_York",
  });
  assert.equal(result.length, 15);
  assert.equal(result[0].id, "reference");
  assert.deepEqual(result.slice(1).map((entry) => entry.id), own.slice(-14).map((entry) => entry.id));
  assert.equal(result[0].sentAt, "2026-09-28 14:39 America/New_York");
});

test("keeps mentioned people readable and represents attachment-only messages", () => {
  const now = Date.parse("2026-09-28T18:40:00Z");
  const withMention = message("mention", "alice", now, "Ask <@222> and <@333>");
  withMention.mentions = { users: new Map([["222", { username: "bobby" }]]) };
  assert.equal(readableDiscordContent(withMention), "Ask @bobby and @user:333");
  assert.equal(mapContextMessage(withMention).content, "Ask @bobby and @user:333");

  const withAttachment = message("file", "alice", now, "");
  withAttachment.attachments = new Map([["1", { name: "notes.pdf" }]]);
  assert.equal(mapContextMessage(withAttachment).content, "[attachments: notes.pdf]");
});
