import { normalizeTimeZone } from "./timezone.js";

export const CHANNEL_CONTEXT_FETCH_LIMIT = 100;
export const CHANNEL_CONTEXT_LIMIT = 15;
export const CONTEXT_CONTENT_CHARS = 500;
const MAX_REFERENCED_CONTEXT = 5;

// A reply or a pasted Discord message link explicitly brings that message
// into the user's context, even when another person wrote it.
export function referencedMessageIds(message) {
  const ids = new Set();
  if (!message) return ids;
  if (message.reference?.messageId) ids.add(message.reference.messageId);
  if (message.content) {
    for (const match of message.content.matchAll(/discord\.com\/channels\/\d+\/\d+\/(\d+)/g)) {
      ids.add(match[1]);
    }
  }
  return ids;
}

function contextTimestamp(timestamp, timeZone) {
  if (!Number.isFinite(timestamp)) return "";
  const zone = normalizeTimeZone(timeZone);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(timestamp))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${zone}`;
}

export function readableDiscordContent(message) {
  return String(message?.content || "").replace(/<@!?(\d+)>/g, (_, id) => {
    const username = message.mentions?.users?.get?.(id)?.username;
    return username ? `@${username}` : `@user:${id}`;
  });
}

function snippet(text) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  return flat.length > CONTEXT_CONTENT_CHARS
    ? `${flat.slice(0, CONTEXT_CONTENT_CHARS - 1).trimEnd()}…`
    : flat;
}

export function mapContextMessage(message, currentSandboxName = null, timeZone = "UTC") {
  const raw = readableDiscordContent(message);
  const sandbox = message?.author?.bot
    ? raw.match(/-#\s*from sandbox:(\S+)/i)?.[1] || null
    : null;
  if (sandbox && currentSandboxName && sandbox.toLowerCase() === currentSandboxName.toLowerCase()) {
    return null; // The user's Pi session already contains this sandbox's output.
  }
  const attachments = [...(message.attachments?.values?.() || [])].slice(0, 3)
    .map((attachment) => attachment.name || attachment.filename || "file");
  const attachmentNote = attachments.length ? `[attachments: ${attachments.join(", ")}]` : "";
  const text = sandbox ? raw.replace(/-#\s*from sandbox:\S+/i, "") : raw;
  const content = snippet([text, attachmentNote].filter(Boolean).join(" "));
  if (!content) return null;
  return {
    id: String(message.id),
    createdTimestamp: message.createdTimestamp,
    author: sandbox ? `punch:${sandbox}` : (message.member?.displayName || message.author.username),
    username: sandbox ? null : message.author.username,
    userId: sandbox ? null : String(message.author.id),
    sentAt: contextTimestamp(message.createdTimestamp, timeZone),
    content,
  };
}

export function visibleToSummoner(message, userId, referencedIds = new Set()) {
  if (referencedIds.has(String(message.id))) return true;
  return !message.author.bot && String(message.author.id) === String(userId);
}

export function selectChannelContext(messages, {
  userId,
  referencedIds = new Set(),
  currentSandboxName = null,
  timeZone = "UTC",
  excludeId = null,
  limit = CHANNEL_CONTEXT_LIMIT,
} = {}) {
  const slots = Math.max(0, Math.floor(Number(limit) || 0));
  if (!slots) return [];
  const selected = [...messages]
    .filter((message) => String(message.id) !== String(excludeId) && visibleToSummoner(message, userId, referencedIds))
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp || String(a.id).localeCompare(String(b.id)))
    .map((message) => mapContextMessage(message, currentSandboxName, timeZone))
    .filter(Boolean);
  const referenced = selected.filter((entry) => referencedIds.has(entry.id))
    .slice(-Math.min(MAX_REFERENCED_CONTEXT, slots));
  const recentSlots = slots - referenced.length;
  const recent = recentSlots
    ? selected.filter((entry) => !referencedIds.has(entry.id)).slice(-recentSlots)
    : [];
  return [...referenced, ...recent]
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp || a.id.localeCompare(b.id));
}

export async function fetchChannelContext(channel, message, {
  userId = null,
  currentSandboxName = null,
  timeZone = "UTC",
  limit = CHANNEL_CONTEXT_LIMIT,
} = {}) {
  if (!channel) return [];
  try {
    // Filter before taking the newest 15 eligible messages. A busy shared
    // channel may have few of this user's messages among the last 15.
    const fetched = await channel.messages.fetch({ limit: CHANNEL_CONTEXT_FETCH_LIMIT, before: message?.id });
    const referenced = referencedMessageIds(message);
    const extraIds = [...referenced].filter((id) => !fetched.has(id)).slice(0, MAX_REFERENCED_CONTEXT);
    const extras = await Promise.all(extraIds.map((id) => channel.messages.fetch(id).catch(() => null)));
    return selectChannelContext([...fetched.values(), ...extras.filter(Boolean)], {
      userId,
      referencedIds: referenced,
      currentSandboxName,
      timeZone,
      limit,
    });
  } catch (err) {
    console.error("[context] failed to fetch recent messages:", err.message);
    return [];
  }
}
