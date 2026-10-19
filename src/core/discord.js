import {
  Client,
  GatewayIntentBits,
  Partials,
} from "discord.js";
import { randomUUID } from "node:crypto";
import * as store from "../memory.js";
import { DOCTOR_REPAIR_TTL_MS, REACTION_DEDUP_MS } from "./config.js";
import { registry } from "./registry.js";

export function createClient() {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessageReactions,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction],
  });
}

export function createDoctorRepairToken(action, sandboxName, requesterId) {
  const now = Date.now();
  for (const [existingToken, repair] of registry.doctorRepairTokens) {
    if (repair.expiresAt < now) registry.doctorRepairTokens.delete(existingToken);
  }
  const token = randomUUID().replace(/-/g, "").slice(0, 16);
  registry.doctorRepairTokens.set(token, { action, sandboxName, requesterId, expiresAt: now + DOCTOR_REPAIR_TTL_MS });
  return token;
}

export function progressBar(pct, width = 16) {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  return "[" + "█".repeat(filled) + "░".repeat(width - filled) + "]";
}

export function contextUsageNote(usage, uid) {
  if (!usage || usage.pct == null) return "";
  const always = store.getUserSettings(uid)?.showContext;
  if (!always && usage.pct < 50) return "";
  const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
  const warn = usage.pct >= 85 ? " ⚠️ near full — consider `/compress` or `/reset`" : usage.pct >= 70 ? " — getting full" : "";
  return `context ${usage.pct}% (${fmt(usage.used)}/${fmt(usage.limit)})${warn}`;
}

export function safeReact(message, emoji) {
  if (!message?.react) return Promise.resolve();
  return message.react(emoji).catch((err) => {
    console.warn(`[react] failed to react ${emoji} on ${message.id}:`, err.message);
  });
}

const REACT_PAIR_RE = /<react\s+emoji="([^"]+)"\s*>[\s\S]*?<\/react>/gi;
const REACT_OPEN_RE = /<react\s+emoji="([^"]+)"\s*\/?>/gi;
const REACT_CLOSE_RE = /<\/react>/gi;

export function extractReactTags(textIn) {
  const emojis = [];
  const collect = (_match, emoji) => {
    if (emoji) emojis.push(emoji);
    return "";
  };
  let clean = String(textIn || "");
  clean = clean.replace(REACT_PAIR_RE, collect);
  clean = clean.replace(REACT_OPEN_RE, collect);
  clean = clean.replace(REACT_CLOSE_RE, "");
  return { clean: clean.trim(), emojis };
}

export async function applyReactTags(message, emojis) {
  const seen = new Set();
  for (const emoji of emojis) {
    if (seen.has(emoji)) continue;
    seen.add(emoji);
    await safeReact(message, emoji);
  }
}

export function reactionDedupKey(userId, messageId) {
  const key = `${userId}:${messageId}`;
  const now = Date.now();
  const existing = registry.recentReactionKeys.get(key);
  if (existing && now - existing < REACTION_DEDUP_MS) return true;
  registry.recentReactionKeys.set(key, now);
  for (const [k, ts] of registry.recentReactionKeys) {
    if (now - ts > REACTION_DEDUP_MS) registry.recentReactionKeys.delete(k);
  }
  return false;
}

export function chunk(text, size = 1900) {
  const out = [];
  let s = text;
  while (s.length > size) {
    let cut = s.lastIndexOf("\n", size);
    if (cut < size * 0.5) cut = size;
    out.push(s.slice(0, cut));
    s = s.slice(cut);
  }
  if (s.length) out.push(s);
  return out;
}

export async function reply(message, text) {
  for (const part of chunk(text)) {
    try {
      await message.reply({ content: part, allowedMentions: { parse: [] } });
    } catch (err) {
      console.error(`[discord] reply failed in ${message.channelId}:`, err.message);
      break;
    }
  }
}
