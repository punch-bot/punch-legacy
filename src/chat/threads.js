// Thread mode: each summon in a guild channel opens a Punch-owned thread and
// the turn runs inside it. Messages posted later in a Punch-owned thread
// auto-summon — no mention or summon word needed. Thread ids double as the
// session key, so every thread keeps its own Pi conversation.

import * as store from "../memory.js";

// A thread "by punch" is one the bot created: Discord records the creator as
// the thread owner, so ownerId survives restarts without extra bookkeeping.
export function isPunchThread(channel, client) {
  return Boolean(
    channel?.isThread?.() &&
      client?.user &&
      channel.ownerId === client.user.id,
  );
}

export function threadNameFor(text) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  const name = cleaned.slice(0, 48).trim();
  return name || "punch";
}

// Thread mode applies to fresh summons at channel top level only: not DMs, not
// inside existing threads (a Punch thread auto-summons anyway; someone else's
// thread keeps normal mention behavior).
export function shouldUseThreadMode(message, userId) {
  if (!message?.guildId) return false;
  const channel = message.channel;
  if (!channel || channel.isThread?.()) return false;
  if (message.hasThread) return false;
  if (typeof message.startThread !== "function") return false;
  return Boolean(store.getUserSettings(userId).threadModeEnabled);
}

// Open a public thread on the summon message. The bot is the creator, so the
// thread is Punch-owned — which is what makes later messages auto-summon.
export async function startPunchThread(message, text) {
  const thread = await message.startThread({
    name: threadNameFor(text),
    autoArchiveDuration: 1440,
    reason: "Punch thread mode",
  });
  await thread.join().catch(() => {});
  return thread;
}

// Redirect the summon message at the thread so everything downstream (thinking
// message, settle replies, typing, questions, attachment fetches) lands in the
// thread while reactions still land on the original message in the parent.
export function threadBoundMessage(message, thread) {
  return new Proxy(message, {
    get(target, prop, receiver) {
      if (prop === "channel") return thread;
      if (prop === "channelId") return thread.id;
      if (prop === "reply") {
        return (options = {}) => {
          const opts =
            typeof options === "string" ? { content: options } : { ...options };
          opts.reply = { messageReference: target.id, failIfNotExists: false };
          return thread.send(opts);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
