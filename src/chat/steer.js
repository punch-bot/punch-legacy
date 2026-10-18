// Steering: while a user's main turn is in flight, a new message in the same
// channel is injected into the running Pi turn via the gateway `steer` RPC
// instead of queueing behind it.

import * as store from "../memory.js";
import { registry } from "../core/registry.js";
import { steerSession } from "../agent.js";
import { safeReact } from "../core/discord.js";
import { userTurnLine } from "../prompt-blocks.js";

// queue[0] is the in-flight turn itself (shifted only after handleChat
// returns), so length <= 1 means nothing is waiting behind it — steering
// must not jump ahead of already-queued messages.
function nothingQueued(uid) {
  const queue = registry.userQueues.get(uid);
  return !queue || queue.length <= 1;
}

// Only steer the turn running in THIS channel — a message elsewhere queues so
// its answer still lands where it was asked. Queued messages stay queued to
// keep FIFO order (steering ahead of them would reorder the conversation).
export function shouldSteerTurn(uid, message, opts = {}) {
  if (opts.forceQueue || opts.pigeonFrom) return false;
  // Steering forwards text only. Voice memos and files need handleChat's
  // transcription and upload, and a reaction summon's target lives in its
  // context, so those queue instead of being dropped behind a 🧭.
  if (opts.reactedTo || message.attachments?.size > 0) return false;
  // A Discord message link pulls that conversation into handleChat's context.
  if (/discord\.com\/channels\/\d+\/\d+\/\d+/.test(message.content || "")) return false;
  if (!store.getUserSettings(uid).steeringEnabled) return false;
  const turn = registry.activeTurns.get(uid);
  if (!turn?.steerable || turn.channelId !== message.channelId) return false;
  return nothingQueued(uid);
}

export async function trySteerTurn(message, text, opts = {}) {
  // An empty summon queues so handleChat can answer "Say something".
  if (!String(text ?? "").trim()) return false;
  const uid = opts.userId ?? message.author.id;
  const who = opts.displayName ?? (message.member?.displayName || message.author.username);
  const speaker = `${who} (@${opts.speakerUsername ?? message.author.username}, id:${uid})`;
  const line = userTurnLine(uid, speaker, text, {
    channelId: message.channelId,
    timeZone: store.getUserSettings(uid).timeZone,
  });
  if (message.reference?.messageId) {
    // Replied-to attachments are also uploaded only by handleChat.
    const ref = await message.channel?.messages?.fetch(message.reference.messageId).catch(() => null);
    if (ref?.attachments?.size > 0) return false;
  }
  // Recheck after the await above: the chat may have finished and a routine
  // taken the lock, or another message may have queued. Steering its own
  // session keeps the gateway from injecting into another active session.
  const turn = registry.activeTurns.get(uid);
  if (!turn?.steerable || !turn.sessionId || turn.channelId !== message.channelId) return false;
  if (!nothingQueued(uid)) return false;
  const steerText = opts.repliedTo ? `${opts.repliedTo}\n\n${line}` : line;
  const result = await steerSession(turn.sessionId, steerText, uid);
  if (!result.ok) {
    console.log(`[steer] uid=${uid} steer failed (${result.error}) — falling back to queue`);
    return false;
  }
  // handleChat folds steered text into the turn's DM memory capture.
  turn.steeredTexts?.push(text);
  console.log(`[steer] uid=${uid} cid=${message.channelId} steered (${result.disposition || "ok"})`);
  await safeReact(message, "🧭");
  return true;
}
