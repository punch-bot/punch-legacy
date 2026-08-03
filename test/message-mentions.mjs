import assert from "node:assert/strict";
import test from "node:test";

import { isBotDirectlyMentioned } from "../src/message-mentions.js";

const BOT_ID = "123456789012345678";

function mockMentions({ userIds = [], everyone = false } = {}) {
  const users = new Map(userIds.map((id) => [id, { id }]));
  return {
    users: {
      has: (id) => users.has(id),
    },
    everyone,
    has: (user) => everyone || users.has(user.id),
  };
}

test("isBotDirectlyMentioned is true for an explicit bot mention", () => {
  const bot = { id: BOT_ID };
  const message = { mentions: mockMentions({ userIds: [BOT_ID] }) };
  assert.equal(isBotDirectlyMentioned(message, bot), true);
});

test("isBotDirectlyMentioned is false for @here / @everyone alone", () => {
  const bot = { id: BOT_ID };
  const message = { mentions: mockMentions({ everyone: true }) };
  assert.equal(message.mentions.has(bot), true, "discord.js has() treats everyone as a mention");
  assert.equal(isBotDirectlyMentioned(message, bot), false);
});

test("isBotDirectlyMentioned is true when bot is mentioned alongside @everyone", () => {
  const bot = { id: BOT_ID };
  const message = { mentions: mockMentions({ userIds: [BOT_ID], everyone: true }) };
  assert.equal(isBotDirectlyMentioned(message, bot), true);
});

test("isBotDirectlyMentioned is false when another user is mentioned", () => {
  const bot = { id: BOT_ID };
  const message = { mentions: mockMentions({ userIds: ["999999999999999999"] }) };
  assert.equal(isBotDirectlyMentioned(message, bot), false);
});
