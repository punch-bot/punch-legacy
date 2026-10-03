// MessageReactionAdd listener: pigeon cancellation (🛑) + reaction-summon
// chat triggering.

import { Events } from "discord.js";
import * as store from "../memory.js";
import * as settings from "../settings.js";
import { sandboxNameForUser } from "../agent.js";
import { registry } from "../core/registry.js";
import { ensureUserSandbox } from "../core/supervisor.js";
import { reactionDedupKey } from "../core/discord.js";
import { enqueueChat } from "../chat/queue.js";
import { fetchChannelContext, fetchThreadContext } from "../chat/context.js";
import * as pigeonGate from "../pigeon-gate.js";
import { notifyPigeonDM } from "../gateway/pigeon.js";
import { isVoiceMessage } from "../stt.js";
import { reactedToBlock } from "../prompt-blocks.js";
import {
  isPunchThread,
  shouldUseThreadMode,
  startPunchThread,
  threadBoundMessage,
} from "../chat/threads.js";

function registerReactionAdd(client) {
  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    if (user.bot) return;

    try {
      if (reaction.partial) await reaction.fetch();
      const targetMessage = reaction.message.partial
        ? await reaction.message.fetch()
        : reaction.message;

      const pendingId = pigeonGate.getPendingIdForMessage(targetMessage.id);
      if (pendingId && reaction.emoji.name === "🛑") {
        const pending = pigeonGate.getPending(pendingId);
        if (pending && user.id === pending.recipientId) {
          pigeonGate.cancelScheduled(pendingId);
          await targetMessage.edit(`🛑 **Agent pigeon cancelled** (from **${pending.from}**).`).catch(() => {});
          const senderUid = pigeonGate.userIdForSandboxName(pending.from);
          const recipientSandbox = sandboxNameForUser(pending.recipientId);
          if (senderUid && recipientSandbox) {
            await notifyPigeonDM(senderUid, recipientSandbox, `Your agent pigeon to **${recipientSandbox}** was cancelled.`);
          }
          return;
        }
      }

      const guildId = targetMessage.guild?.id;
      const isDM = !guildId;

      if (!isDM) {
        const gs = store.getGuildSettings(guildId);
        if (!gs.reactionSummonEnabled) return;
        if (!settings.reactionMatches(reaction, gs.reactionSummonEmoji)) return;

        const allowedChannel = store.getAllowedChannel(guildId);
        if (
          allowedChannel &&
          targetMessage.channelId !== allowedChannel &&
          targetMessage.channel?.parentId !== allowedChannel
        ) return;
      } else {
        if (!settings.reactionMatches(reaction, store.GUILD_SETTINGS_DEFAULTS.reactionSummonEmoji)) return;
      }

      if (reactionDedupKey(user.id, targetMessage.id)) return;

      const sandboxUrl = await ensureUserSandbox(user.id);
      if (!sandboxUrl) return;

      const authorName = targetMessage.member?.displayName || targetMessage.author.username;
      let content = targetMessage.content.replace(/<@!?\d+>/g, "").trim();
      if (!content && isVoiceMessage(targetMessage)) {
        content = "(voice memo — Punch will transcribe it)";
      } else if (!content && targetMessage.attachments.size > 0) {
        content = `(message has ${targetMessage.attachments.size} attachment(s))`;
      }
      if (!content) content = "(empty message)";

      const reactedTo = reactedToBlock(authorName, content);

      const useChannelContext =
        targetMessage.guild && store.getGuildSettings(targetMessage.guild.id).contextMode === "channel";
      const contextMessages = useChannelContext
        ? await fetchChannelContext(targetMessage.channel, targetMessage.id, sandboxNameForUser(user.id))
        : await fetchThreadContext(targetMessage.channel, targetMessage, { userId: user.id });

      console.log(`[react-summon] uid=${user.id} msg=${targetMessage.id}`);

      // Thread mode: the reaction summon opens a Punch-owned thread on the
      // reacted-to message and the turn is redirected into it.
      let turnMessage = targetMessage;
      if (
        !isDM &&
        !isPunchThread(targetMessage.channel, client) &&
        shouldUseThreadMode(targetMessage, user.id)
      ) {
        try {
          const thread = await startPunchThread(targetMessage, content);
          if (thread) turnMessage = threadBoundMessage(targetMessage, thread);
        } catch (err) {
          console.error("[threads] failed to start punch thread:", err.message);
        }
      }

      await enqueueChat(
        turnMessage,
        "(reacted to the message above — respond to it)",
        contextMessages,
        {
          userId: user.id,
          displayName: user.displayName || user.username,
          speakerUsername: user.username,
          reactedTo,
        },
      );
    } catch (err) {
      console.error("[react-summon] error:", err.message);
    }
  });
}

export { registerReactionAdd };
