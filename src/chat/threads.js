import * as store from "../memory.js";

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

export function shouldUseThreadMode(message, userId, text) {
  if (!message?.guildId) return false;
  if (!String(text ?? "").trim()) return false;
  const channel = message.channel;
  if (!channel || channel.isThread?.()) return false;
  if (message.hasThread) return false;
  if (typeof message.startThread !== "function") return false;
  return Boolean(store.getUserSettings(userId).threadModeEnabled);
}

export function canAutoSummon(channel, client, userId) {
  if (!isPunchThread(channel, client)) return false;
  return store.getThreadOwner(channel.id) === userId;
}

export async function startPunchThread(message, text, userId) {
  const thread = await message.startThread({
    name: threadNameFor(text),
    autoArchiveDuration: 1440,
    reason: "Punch thread mode",
  });
  await thread.join().catch(() => {});
  store.setThreadOwner(thread.id, userId);
  return thread;
}

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
