import * as store from "../memory.js";
import { registry } from "../core/registry.js";
import { steerSession } from "../agent.js";
import { safeReact } from "../core/discord.js";
import { userTurnLine } from "../prompt-blocks.js";

function nothingQueued(uid) {
  const queue = registry.userQueues.get(uid);
  return !queue || queue.length <= 1;
}

export function shouldSteerTurn(uid, message, opts = {}) {
  if (opts.forceQueue || opts.pigeonFrom) return false;
  if (opts.reactedTo || message.attachments?.size > 0) return false;
  if (/discord\.com\/channels\/\d+\/\d+\/\d+/.test(message.content || "")) return false;
  if (!store.getUserSettings(uid).steeringEnabled) return false;
  const turn = registry.activeTurns.get(uid);
  if (!turn?.steerable || turn.channelId !== message.channelId) return false;
  return nothingQueued(uid);
}

export async function trySteerTurn(message, text, opts = {}) {
  if (!String(text ?? "").trim()) return false;
  const uid = opts.userId ?? message.author.id;
  const who = opts.displayName ?? (message.member?.displayName || message.author.username);
  const speaker = `${who} (@${opts.speakerUsername ?? message.author.username}, id:${uid})`;
  const line = userTurnLine(uid, speaker, text, {
    channelId: message.channelId,
    timeZone: store.getUserSettings(uid).timeZone,
  });
  if (message.reference?.messageId) {
    const ref = await message.channel?.messages?.fetch(message.reference.messageId).catch(() => null);
    if (ref?.attachments?.size > 0) return false;
  }
  const turn = registry.activeTurns.get(uid);
  if (!turn?.steerable || !turn.sessionId || turn.channelId !== message.channelId) return false;
  if (!nothingQueued(uid)) return false;
  const steerText = opts.repliedTo ? `${opts.repliedTo}\n\n${line}` : line;
  const result = await steerSession(turn.sessionId, steerText, uid);
  if (!result.ok) {
    console.log(`[steer] uid=${uid} steer failed (${result.error}) — falling back to queue`);
    return false;
  }
  turn.steeredTexts?.push(text);
  console.log(`[steer] uid=${uid} cid=${message.channelId} steered (${result.disposition || "ok"})`);
  await safeReact(message, "🧭");
  return true;
}
