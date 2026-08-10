// MessageCreate listener: prefix commands + chat-turn triggering (mentions,
// DM, voice memos, summon words, replies) with thread/channel context.

import { Events } from "discord.js";
import * as store from "../memory.js";
import { sandboxNameForUser } from "../agent.js";
import { PREFIX } from "../core/config.js";
import { handleCommand } from "../commands/prefix.js";
import { enqueueChat } from "../chat/queue.js";
import { fetchChannelContext, fetchThreadContext } from "../chat/context.js";
import { isBotDirectlyMentioned } from "../message-mentions.js";
import {
  isVoiceMessage,
  shouldAcceptChatTurn,
} from "../stt.js";
import { repliedToBlock } from "../prompt-blocks.js";

function registerMessageCreate(client) {
  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot && !store.getUserSettings(message.author.id).allowBots) return;

    const isDM = !message.guild;
    const mentioned = isBotDirectlyMentioned(message, client.user);
    const content = message.content.trim();
    const voiceMemo = isVoiceMessage(message);

    console.log(
      `[msg] dm=${isDM} mention=${mentioned} voice=${voiceMemo} len=${content.length} from=${message.author.username}`,
    );

    if (content.startsWith(PREFIX)) {
      const [cmd, ...args] = content.slice(PREFIX.length).split(/\s+/);
      const rest = content.slice(PREFIX.length + cmd.length).trim();
      const handled = await handleCommand(message, cmd.toLowerCase(), rest);
      if (handled) return;
      if (!isDM && !mentioned) return;
    }

    const allowedChannel = message.guild ? store.getAllowedChannel(message.guild.id) : null;
    if (allowedChannel && message.channelId !== allowedChannel) {
      return;
    }

    const summonWord = (!isDM && message.guild) ? (store.getUserTrigger(message.author.id) || store.getSummonWord(message.guild.id)) : null;
    if (!isDM && !mentioned && !message.content.startsWith(PREFIX)) {
      const replyToBot = voiceMemo ? await isReplyToBot(message, client) : false;
      const summonMatched = summonWord
        ? content.toLowerCase().split(/\s+/).includes(summonWord)
        : false;
      if (!shouldAcceptChatTurn({
        isDM,
        mentioned,
        contentStartsWithPrefix: false,
        voiceMemo,
        replyToBot,
        summonMatched,
      })) {
        return;
      }
    }

    let text = content.replace(/<@!?\d+>/g, "").trim();
    if (summonWord) {
      text = text.replace(new RegExp(`\\b${summonWord}\\b`, "gi"), "").trim();
    }

    // Collect the message this one is replying to (if any) as focused context
    const repliedTo = await buildRepliedToContext(message);

    // Collect context: thread-scoped by default, or legacy channel-scoped if the
    // guild opted into `channel` mode via /settings context.
    const useChannelContext =
      message.guild && store.getGuildSettings(message.guild.id).contextMode === "channel";
    const contextMessages = useChannelContext
      ? await fetchChannelContext(message.channel, message.id, sandboxNameForUser(message.author.id))
      : await fetchThreadContext(message.channel, message, { userId: message.author.id });

    await enqueueChat(message, text, contextMessages, repliedTo ? { repliedTo } : {});
  });
}

async function isReplyToBot(message, client) {
  if (!message.reference?.messageId || !client.user) return false;
  try {
    const refMsg = message.referencedMessage
      || await message.channel.messages.fetch(message.reference.messageId);
    return refMsg?.author?.id === client.user.id;
  } catch (err) {
    console.error("[stt] failed to fetch replied message for voice gate:", err.message);
    return false;
  }
}

async function buildRepliedToContext(message) {
  if (!message.reference?.messageId) return null;
  try {
    const refMsg = await message.channel.messages.fetch(message.reference.messageId);
    if (!refMsg) return null;
    const authorName = refMsg.member?.displayName || refMsg.author.username;
    let content = refMsg.content.replace(/<@!?\d+>/g, "").trim();
    if (!content && isVoiceMessage(refMsg)) {
      content = "(voice memo)";
    } else if (!content && refMsg.attachments.size > 0) {
      content = `(message has ${refMsg.attachments.size} attachment(s))`;
    }
    if (!content) content = "(empty message)";
    return repliedToBlock(authorName, content);
  } catch (err) {
    console.error("[reply-context] failed to fetch replied message:", err.message);
    return null;
  }
}

export { registerMessageCreate, isReplyToBot, buildRepliedToContext };
