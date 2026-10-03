// Steering: while a user's main turn is in flight, a new message in the same
// channel is injected into the running Pi turn via the gateway `steer` RPC
// instead of queueing behind it or spawning a multitask worker.

import * as store from "../memory.js";
import { registry } from "../core/registry.js";
import { steerSession } from "../agent.js";
import { safeReact } from "../core/discord.js";
import { userTurnLine } from "../prompt-blocks.js";

// Only steer the turn running in THIS channel — a message elsewhere queues so
// its answer still lands where it was asked. Queued messages stay queued to
// keep FIFO order (steering ahead of them would reorder the conversation).
export function shouldSteerTurn(uid, message, opts = {}) {
  if (opts.forceQueue || opts.pigeonFrom) return false;
  if (!store.getUserSettings(uid).steeringEnabled) return false;
  const turn = registry.activeTurns.get(uid);
  if (!turn || turn.channelId !== message.channelId) return false;
  const queue = registry.userQueues.get(uid);
  return !queue || queue.length === 0;
}

export async function trySteerTurn(message, text, opts = {}) {
  const uid = opts.userId ?? message.author.id;
  const who = opts.displayName ?? (message.member?.displayName || message.author.username);
  const speaker = `${who} (@${opts.speakerUsername ?? message.author.username}, id:${uid})`;
  const line = userTurnLine(uid, speaker, text, {
    channelId: message.channelId,
    timeZone: store.getUserSettings(uid).timeZone,
  });
  const result = await steerSession(null, line, uid);
  if (!result.ok) {
    console.log(`[steer] uid=${uid} steer failed (${result.error}) — falling back to queue`);
    return false;
  }
  console.log(`[steer] uid=${uid} cid=${message.channelId} steered (${result.disposition || "ok"})`);
  await safeReact(message, "🧭");
  return true;
}
