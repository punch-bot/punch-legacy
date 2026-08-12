import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  Status,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  CheckboxGroupBuilder,
  LabelBuilder,
  REST,
  Routes,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { runAgent, getFile, listBackgroundTasks, killBackgroundTask, runBackgroundTask, execCommand, setSecret, getSecrets, setEnv, getEnv, reloadSandboxMap, apiUrlFor, abortSession, sandboxNameForUser, summarizeSession, syncMultitaskWorkerCap, getMultitaskWorkerSettings } from "./agent.js";
import { validateAutoCompressThreshold } from "./context-compression.js";
import { extractCompressTag } from "./compress-tag.mjs";
import { filterThreadSubtree } from "./thread-context.js";
import { isBotDirectlyMentioned } from "./message-mentions.js";
import * as store from "./memory.js";
import * as sandbox from "./sandbox-manager.js";
import * as routines from "./routines.js";
import * as settings from "./settings.js";
import { formatInTimeZone, formatMessageTimestamp } from "./timezone.js";
import { assessAgentPigeon, scanOutbound, pigeonTurnPreamble } from "./pigeon-supervisor.js";
import {
  channelContextBlock,
  thisTurnInstructions,
  reactedToBlock,
  repliedToBlock,
  memoryBlock,
  timestampLine,
  multitaskPrompt,
  userTurnLine,
  assemblePrompt,
} from "./prompt-blocks.js";
import { notifyPigeonDone } from "./pigeon-done.js";
import * as pigeonGate from "./pigeon-gate.js";
import { resolvePeerSandbox, isRegisteredSandboxName } from "./pigeon-peer.js";
import { setPigeonTrust, setPigeonDeny } from "./settings.js";
import * as logs from "./logs.js";
import * as state from "./state.js";
import * as statistics from "./statistics.js";
import * as collabs from "./collabs.js";
import { renderDoctorReport, runDoctor } from "./doctor/index.js";
import {
  createProgressRenderer,
  createProgressState,
  reduceProgressEvent,
  renderProgressLive,
} from "./progress-ui.js";
import {
  discardThinkingMessage,
  isVoiceMessage,
  mergeTranscriptIntoText,
  resolveSttConfig,
  shouldAcceptChatTurn,
  STT_USER_ERROR_GENERIC,
  transcribeVoiceMessage,
} from "./stt.js";

const TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = process.env.PREFIX || "!";
const DOCTOR_REPAIR_TTL_MS = 10 * 60_000;
const doctorRepairTokens = new Map();
const workerProgressSent = new Map();
const activeTurns = new Map();

function createDoctorRepairToken(action, sandboxName, requesterId) {
  const now = Date.now();
  for (const [existingToken, repair] of doctorRepairTokens) {
    if (repair.expiresAt < now) doctorRepairTokens.delete(existingToken);
  }
  const token = randomUUID().replace(/-/g, "").slice(0, 16);
  doctorRepairTokens.set(token, { action, sandboxName, requesterId, expiresAt: now + DOCTOR_REPAIR_TTL_MS });
  return token;
}

if (!TOKEN) {
  console.error("Missing DISCORD_TOKEN. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const client = new Client({
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

const recentReactionKeys = new Map();
const REACTION_DEDUP_MS = 5000;

const LIFECYCLE_PROGRESS_EMOJI = "👀";

function progressBar(pct, width = 16) {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  return "[" + "█".repeat(filled) + "░".repeat(width - filled) + "]";
}

// Render a compact context-window indicator from a turn's token usage. Only
// surfaced once the window starts filling (>=50%) so it isn't noisy on every
// reply, or always when the user opted into `showContext`. Warns near the top.
function contextUsageNote(usage, uid) {
  if (!usage || usage.pct == null) return "";
  const always = store.getUserSettings(uid)?.showContext;
  if (!always && usage.pct < 50) return "";
  const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
  const warn = usage.pct >= 85 ? " ⚠️ near full — consider `/compress` or `/reset`" : usage.pct >= 70 ? " — getting full" : "";
  return `context ${usage.pct}% (${fmt(usage.used)}/${fmt(usage.limit)})${warn}`;
}

function safeReact(message, emoji) {
  if (!message?.react) return Promise.resolve();
  return message.react(emoji).catch((err) => {
    console.warn(`[react] failed to react ${emoji} on ${message.id}:`, err.message);
  });
}

async function safeUnreact(message, emoji) {
  if (!message?.reactions?.cache || !client.user) return;
  try {
    const reaction = message.reactions.cache.get(emoji);
    if (reaction) await reaction.users.remove(client.user.id);
  } catch (err) {
    console.warn(`[react] failed to unreact ${emoji} on ${message.id}:`, err.message);
  }
}

async function finishLifecycleReact(message, emoji) {
  await safeUnreact(message, LIFECYCLE_PROGRESS_EMOJI);
  await safeReact(message, emoji);
}

const REACT_PAIR_RE = /<react\s+emoji="([^"]+)"\s*>[\s\S]*?<\/react>/gi;
const REACT_OPEN_RE = /<react\s+emoji="([^"]+)"\s*\/?>/gi;
const REACT_CLOSE_RE = /<\/react>/gi;

function extractReactTags(textIn) {
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

async function applyReactTags(message, emojis) {
  const seen = new Set();
  for (const emoji of emojis) {
    if (seen.has(emoji)) continue;
    seen.add(emoji);
    await safeReact(message, emoji);
  }
}

function reactionDedupKey(userId, messageId) {
  const key = `${userId}:${messageId}`;
  if (recentReactionKeys.has(key)) return true;
  recentReactionKeys.set(key, Date.now());
  for (const [k, ts] of recentReactionKeys) {
    if (Date.now() - ts > REACTION_DEDUP_MS) recentReactionKeys.delete(k);
  }
  return false;
}

async function fetchChannelContext(channel, beforeId, currentSandboxName = null) {
  if (!channel) return [];
  try {
    const fetched = await channel.messages.fetch({ limit: 15, before: beforeId });
    return fetched
      .map((m) => mapContextMsg(m, currentSandboxName))
      .filter((m) => m && m.content.length > 0)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .slice(-15);
  } catch (err) {
    console.error("[context] failed to fetch recent messages:", err.message);
    return [];
  }
}

const THREAD_WINDOW = 100;
const RESIDUE_LIMIT = 10;

// Walk a message's reply chain upward to find the root of its thread.
// Caps at 12 hops; fetches each parent individually.
// v2: batch these individual fetches into one bulk fetch if it ever feels slow.
async function resolveRoot(channel, startId) {
  let cur = await channel.messages.fetch(startId).catch(() => null);
  if (!cur) return null;
  let hops = 0;
  while (cur.reference?.messageId && hops < 12) {
    const parentId = cur.reference.messageId;
    const parent = await channel.messages.fetch(parentId).catch(() => null);
    if (!parent) break;
    cur = parent;
    hops += 1;
  }
  return cur;
}

// Map a Discord message into the { author, content } context shape.
// Human messages are tagged by display name. Bot messages are other punches'
// output: we strip the `-# from sandbox:NAME` footer, attribute them as
// `[punch:NAME]`, and skip the summoner's OWN prior output (the Pi
// session already carries it). Attributed punch output lets one punch SEE what
// another punch did in the thread without mistaking it for a command.
function mapContextMsg(m, currentSandboxName) {
  const raw = m.content.replace(/<@!?\d+>/g, "").trim();
  if (m.author.bot) {
    const m2 = raw.match(/-#\s*from sandbox:(\S+)/i);
    const name = m2 ? m2[1] : null;
    const content = raw.replace(/-#\s*from sandbox:\S+/i, "").trim().slice(0, 200);
    if (!content) return null;
    if (name && currentSandboxName && name.toLowerCase() === currentSandboxName.toLowerCase()) {
      return null; // own prior output — session history already has it
    }
    // Known Punch sandboxes are tagged `punch:NAME`; foreign bots (no sandbox
    // footer) are attributed by their own display name so context isn't
    // mislabeled as a Punch.
    const author = name ? `punch:${name}` : (m.member?.displayName || m.author.username);
    return { author, content };
  }
  return {
    author: m.member?.displayName || m.author.username,
    content: raw.slice(0, 200),
  };
}

// Thread-scoped context: ingest only the reply subtree rooted at the summoning
// message's root. Humans are always visible; other punches' output is included
// (attributed as `[punch:NAME]`) so the summoning punch can see what its
// neighbours are doing, while its OWN prior output is skipped to avoid loops.
async function fetchThreadContext(channel, message, opts = {}) {
  if (!channel) return [];
  const currentSandboxName = sandboxNameForUser(opts.userId) || null;
  try {
    const root = await resolveRoot(channel, message.id);
    if (!root) {
      return fetchChannelContext(channel, message.id, currentSandboxName).slice(-RESIDUE_LIMIT);
    }

    const fetched = await channel.messages.fetch({ limit: THREAD_WINDOW, before: message.id });
    const all = [root, ...fetched.values()];
    const mapped = all.map((m) => ({ id: m.id, referenceMessageId: m.reference?.messageId || null }));
    const keep = filterThreadSubtree(mapped, root.id);
    const kept = all
      .filter((m) => keep.has(m.id))
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map((m) => mapContextMsg(m, currentSandboxName))
      .filter((m) => m && m.content.length > 0);
    let result = kept;

    // Non-reply ping (root == the summon itself): no thread has formed yet, so
    // add a small ambient residue of recent human messages for context.
    if (root.id === message.id && result.length <= 1) {
      const residue = fetchChannelContext(channel, message.id, currentSandboxName).slice(-RESIDUE_LIMIT);
      result = result.concat(residue);
    }

    // Cross-ping escape hatch: a Discord message link in the summon pulls that
    // other thread's messages into context too (bot output attributed as
    // [punch:NAME], outputs stay distinct).
    // v2: also scan message.reference for linked messages, and support multiple links.
    const linkMatch = message.content.match(/discord\.com\/channels\/\d+\/\d+\/(\d+)/);
    if (linkMatch) {
      const linked = await channel.messages.fetch(linkMatch[1]).catch(() => null);
      if (linked) {
        const linkedRoot = await resolveRoot(channel, linked.id);
        if (linkedRoot) {
          const lfetched = await channel.messages.fetch({ limit: THREAD_WINDOW, before: message.id });
          const lall = [linkedRoot, ...lfetched.values()];
          const lmapped = lall.map((m) => ({ id: m.id, referenceMessageId: m.reference?.messageId || null }));
          const lkeep = filterThreadSubtree(lmapped, linkedRoot.id);
          const lkept = lall
            .filter((m) => lkeep.has(m.id) && m.id !== message.id)
            .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
            .map((m) => mapContextMsg(m, currentSandboxName))
            .filter((m) => m && m.content.length > 0);
          result = result.concat(lkept);
        }
      }
    }

    return result.slice(-THREAD_WINDOW);
  } catch (err) {
    console.error("[context] thread fetch failed:", err.message);
    return [];
  }
}

function progressSettingsFor(message) {
  const isDM = !message.guild;
  if (isDM) {
    return { useLifecycle: false, useThinking: true };
  }
  const gs = store.getGuildSettings(message.guild.id);
  if (!gs.reactionProgressEnabled) {
    return { useLifecycle: false, useThinking: true };
  }
  if (gs.reactionProgressMode === "reactions") {
    return { useLifecycle: true, useThinking: false };
  }
  if (gs.reactionProgressMode === "text") {
    return { useLifecycle: false, useThinking: true };
  }
  return { useLifecycle: true, useThinking: true };
}

const settingsDeps = () => ({
  prefix: PREFIX,
  botUsername: client.user?.username || "Punch",
  setSecret,
  getSecrets,
});

const MODEL_LIST = [
  { label: "Claude Sonnet 4", value: "anthropic/claude-sonnet-4-20250514", emoji: "🧠" },
  { label: "Claude 3.5 Sonnet", value: "anthropic/claude-3.5-sonnet-20241022", emoji: "🧠" },
  { label: "Claude 3.7 Sonnet", value: "anthropic/claude-3.7-sonnet-20250219", emoji: "🧠" },
  { label: "Claude Opus 4", value: "anthropic/claude-opus-4-20250514", emoji: "⭐" },
  { label: "GPT-4o", value: "openai/gpt-4o", emoji: "🤖" },
  { label: "GPT-4o-mini", value: "openai/gpt-4o-mini", emoji: "🤖" },
  { label: "o3-mini", value: "openai/o3-mini", emoji: "🤖" },
  { label: "Gemini 2.5 Pro", value: "google/gemini-2.5-pro-preview-05-06", emoji: "🔮" },
  { label: "Gemini 2.0 Flash", value: "google/gemini-2.0-flash-001", emoji: "🔮" },
  { label: "DeepSeek Chat", value: "deepseek/deepseek-chat", emoji: "🌊" },
  { label: "Claude 3 Haiku", value: "anthropic/claude-3-haiku-20240307", emoji: "⚡" },
  { label: "Claude Sonnet 4.5 (default)", value: "anthropic/claude-sonnet-4-5", emoji: "🧠" },
  { label: "Poolside Laguna Medium", value: "poolside/poolside/laguna-m.1", emoji: "🏊" },
  { label: "Poolside Laguna XS", value: "poolside/poolside/laguna-xs-2.1", emoji: "🏊" },
  { label: "NIM GLM-5.2 (z-ai)", value: "nim/z-ai/glm-5.2", emoji: "💚" },
  { label: "NIM Nemotron 70B", value: "nim/nvidia/llama-3.1-nemotron-70b-instruct", emoji: "💚" },
  { label: "Custom model...", value: "__custom__", emoji: "✏️" },
];

const PROVIDER_NAMES = ["anthropic", "openai", "openrouter", "google", "deepseek", "groq", "together", "poolside", "opencode", "nim"];

async function ensureUserSandbox(userId) {
  const apiUrl = apiUrlFor(userId);
  if (!apiUrl || !userId) return null;
  try {
    const res = await fetch(`${apiUrl}/env`, {
      headers: {
        authorization: "Basic " + Buffer.from("opencode:" + (process.env.OPENCODE_SERVER_PASSWORD || "")).toString("base64")
      }
    });
    if (!res.ok) throw new Error(`sandbox reachability check failed: ${res.status}`);
    return apiUrl;
  } catch (err) {
    console.error(`[sandbox] cannot reach sandbox for ${userId} at ${apiUrl}:`, err.message);
    return null;
  }
}

function chunk(text, size = 1900) {
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

async function reply(message, text) {
  for (const part of chunk(text)) {
    try {
      await message.reply(part);
    } catch (err) {
      console.error(`[discord] reply failed in ${message.channelId}:`, err.message);
      break;
    }
  }
}

function activeTurnText(uid) {
  const turn = activeTurns.get(uid);
  const lines = [];
  if (turn) {
    const elapsed = Math.round((Date.now() - turn.startedAt) / 1000);
    const detail = turn.detail ? ` — ${turn.detail}` : "";
    lines.push(`Main turn: **${turn.phase}** (${elapsed}s)${detail}`);
  } else {
    const queue = userQueues.get(uid);
    if (queue?.length) lines.push(`Queue: ${queue.length} request(s) waiting`);
  }
  return lines.length ? lines.join("\n") : "No active turn.";
}

function supervisorAuth() {
  return "Basic " + Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD || ""}`).toString("base64");
}

function isMainChatBusy(uid) {
  return activeTurns.has(uid) || (userQueues.get(uid)?.length > 0);
}

function shouldUseMultitaskWorker(uid, opts = {}) {
  if (opts.forceQueue || opts.pigeonFrom) return false;
  if (!store.getUserSettings(uid).multitaskEnabled) return false;
  return isMainChatBusy(uid);
}

function buildMultitaskPrompt(text, contextMessages = [], sentAt) {
  return multitaskPrompt(text, contextMessages, sentAt);
}

async function deliverWorkerToChannel(worker, content) {
  if (!worker?.channelId) return false;
  try {
    const channel = await client.channels.fetch(worker.channelId);
    const payload = { content, allowedMentions: { parse: [] } };
    if (worker.messageId) {
      await channel.send({
        ...payload,
        reply: { messageReference: worker.messageId, failIfNotExists: false },
      });
    } else {
      await channel.send(payload);
    }
    return true;
  } catch (err) {
    console.warn(`[workers] channel delivery failed:`, err.message);
    return false;
  }
}

async function startMultitaskWorker(uid, { channelId, messageId, text, contextMessages = [], opts = {}, messageCreatedAt }) {
  const url = apiUrlFor(uid);
  if (!url) return { ok: false, error: "No sandbox assigned." };

  const kind = opts.workerKind || "coding";
  const timeoutMinutes = Math.max(1, Math.min(30, opts.timeoutMinutes || 10));
  const sentAt = formatMessageTimestamp(messageCreatedAt, store.getUserSettings(uid).timeZone);
  const prompt = buildMultitaskPrompt(text, contextMessages, sentAt);

  try {
    const res = await fetch(`${url}/workers`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: supervisorAuth() },
      body: JSON.stringify({
        kind,
        prompt,
        channelId,
        messageId,
        source: "multitask",
        model: opts.model || undefined,
        timeoutMs: timeoutMinutes * 60_000,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(body.slice(0, 200) || `worker API ${res.status}`);
    }
    const { worker } = await res.json();
    return { ok: true, worker };
  } catch (err) {
    if (/Worker limit reached/i.test(err.message)) {
      console.log(`[multitask] uid=${uid} worker limit — falling back to queue`);
      return { ok: false, fallbackQueue: true, error: err.message };
    }
    return { ok: false, error: err.message };
  }
}

async function trySpawnMultitaskWorker(message, text, contextMessages = [], opts = {}) {
  const uid = opts.userId ?? message.author.id;
  const result = await startMultitaskWorker(uid, {
    channelId: message.channelId,
    messageId: message.id,
    messageCreatedAt: message.createdTimestamp,
    text,
    contextMessages,
    opts,
  });
  if (result.ok) {
    await reply(
      message,
      `🧵 Started subtask \`${result.worker.id.slice(0, 8)}\` (${result.worker.kind}) — I'll reply here when done.`,
    );
    return true;
  }
  if (result.fallbackQueue) return false;
  await reply(message, `⚠️ Could not start subtask: ${result.error}`);
  return true;
}

async function listActiveWorkers(uid) {
  const url = apiUrlFor(uid);
  if (!url) return [];
  try {
    const res = await fetch(`${url}/workers`, { headers: { authorization: supervisorAuth() } });
    if (!res.ok) return [];
    const { workers } = await res.json();
    return (workers || []).filter((worker) => worker.active || ["queued", "running"].includes(worker.status));
  } catch {
    return [];
  }
}

async function activeStatusText(uid) {
  const lines = [activeTurnText(uid)];
  const workers = await listActiveWorkers(uid);
  if (workers.length) {
    lines.push(
      `Workers: ${workers
        .slice(0, 5)
        .map((worker) => `\`${worker.id.slice(0, 8)}\` ${worker.kind} **${worker.status}**`)
        .join(", ")}`,
    );
  }
  if (lines.length === 1 && lines[0] === "No active turn.") return lines[0];
  return lines.join("\n");
}

function splitWhenAndText(rest, timeZone = null) {
  const words = rest.trim().split(/\s+/);
  if (words.length < 2) {
    throw new Error("Need a time and message, e.g. `30m take meds`");
  }
  for (let i = words.length - 1; i >= 1; i--) {
    const whenPart = words.slice(0, i).join(" ");
    const textPart = words.slice(i).join(" ");
    try {
      routines.parseTime(whenPart, new Date(), timeZone);
      return { when: whenPart, text: textPart };
    } catch {
      continue;
    }
  }
  throw new Error(`Could not parse time from: "${rest}"`);
}

function routineContextFromMessage(message) {
  return {
    userId: message.author.id,
    channelId: message.channelId,
    guildId: message.guild?.id || null,
  };
}

function routineContextFromInteraction(interaction) {
  return {
    userId: interaction.user.id,
    channelId: interaction.channelId,
    guildId: interaction.guild?.id || null,
  };
}

function userTimeZone(userId) {
  return store.getUserSettings(userId).timeZone || "UTC";
}

function statisticsExtrasForUser(userId) {
  const sandboxName = sandbox.loadUsers().find((entry) => entry.userId === userId)?.name || null;
  const activeRoutines = routines.listRoutines(userId).filter((routine) => routine.enabled !== false).length;
  const memoryRecords = store.list("user", userId).length;
  return { sandboxName, activeRoutines, memoryRecords };
}

async function createRoutineReply(message, opts) {
  const timezone = opts.timezone || userTimeZone(opts.userId || message.author.id);
  const routine = routines.addRoutine({ ...opts, timezone });
  const when = formatInTimeZone(routine.nextRunAt, routine.timezone || timezone) || new Date(routine.nextRunAt).toISOString();
  await reply(message, `⏰ Scheduled (\`${routine.id}\`) — fires ${when}`);
  return routine;
}


async function sendLogReply(target, userId, { source = "all", lines = 30 } = {}) {
  const result = await logs.fetchLogs(userId, { source, lines });
  const formatted = logs.formatLogReply(result.lines, result.title);
  const running = result.running ? "✅" : "❌";
  const prefix = `**${result.sandbox}** ${running}\n`;
  const payload = {
    content: prefix + formatted.content,
    files: formatted.truncated
      ? [{ attachment: Buffer.from(formatted.fullText, "utf8"), name: "logs.txt" }]
      : undefined,
  };
  if (target.editReply) {
    await target.editReply(payload);
  } else {
    await target.reply(payload);
  }
}

async function handleCommand(message, cmd, rest) {
  const uid = message.author.id;
  const cid = message.channelId;

  switch (cmd) {
    case "status": {
      await reply(message, await activeStatusText(uid));
      return true;
    }
    case "help": {
      const embed = new EmbedBuilder()
        .setTitle("punch — Discord → Pi bridge")
        .setDescription("Mention me, DM me, or send a voice memo in a DM or as a reply to me in a server. Commands:")
        .addFields(
          { name: "Memory", value: `\`\`${PREFIX}remember <text>\`\` — save a fact about you\n\`\`${PREFIX}remember-channel <text>\`\` — save a fact for this channel\n\`\`${PREFIX}memories\`\` — list your + channel memories\n\`\`${PREFIX}forget <id>\`\` — delete a memory by id`, inline: true },
          { name: "Session", value: `\`\`${PREFIX}reset\`\` — start a fresh Pi session here`, inline: true },
          { name: "\u200B", value: "\u200B" },
          { name: "Background Tasks", value: `\`\`${PREFIX}status\`\` — show active turn + workers\n\`\`${PREFIX}stop\`\` — cancel all queued/in-flight requests\n\`/multitask\` — parallel subtasks while busy\n\`\`${PREFIX}exec <command>\`\` — run a command and get output\n\`\`${PREFIX}bg <command>\`\` — run a command in background\n\`\`${PREFIX}tasks\`\` — list processes (dropdown to kill)\n\`\`${PREFIX}task-log <filename>\`\` — view task log (last 20 lines)\n\`\`${PREFIX}logs [source] [lines]\`\` — sandbox / Pi gateway logs`, inline: true },
          { name: "\u200B", value: "\u200B" },
          { name: "Channel Settings", value: "`/settings` — summon word, channel lock, reaction summon, progress mode\n`/settings view` to see current values\n`!setup` / `!forget-channel` — channel lock aliases", inline: true },
          { name: "Routines", value: `\`\`${PREFIX}remind <when> <text>\`\` — one-shot reminder\n\`\`${PREFIX}routine list\`\` — list your routines\n\`\`${PREFIX}routine history [id]\`\` — recent runs and errors\n\`\`${PREFIX}routine remove <id>\`\` — delete a routine\n\`\`${PREFIX}routine pause/resume <id>\`\` — toggle a routine\n\`\`${PREFIX}routine daily <time> <text>\`\` — daily reminder\n\`\`${PREFIX}routine auto <when> <prompt>\`\` — LLM automation`, inline: true },
          { name: "Slash Commands", value: "`/settings` — configure Punch\n`/reset` — start a fresh Pi session\n`/logs` — sandbox + Pi gateway logs\n`/routine add` — schedule a routine\n`/remind` — quick one-shot reminder\nReact with the summon emoji on a message to invoke Punch on it\n**Voice memos:** DM me, or reply to me in a server (free: `GROQ_API_KEY` / `/apikey set groq`)\n**Pigeons:** permission DM, rate limits, optional buffer (`/settings pigeon`)", inline: true }
        )
        .setColor(0x0099ff)
        .setFooter({ text: "poolside/poolside/laguna-m.1" });
      await message.reply({ embeds: [embed] });
      return true;
    }

    case "invite": {
      const cid = client.user.id;
      const url = `https://discord.com/api/oauth2/authorize?client_id=${cid}&permissions=0&scope=bot%20applications.commands`;
      await message.reply(`Re-invite the bot with this link to enable slash commands:\n${url}`);
      return true;
    }

    case "remember": {
      if (!rest) return void (await reply(message, "Usage: \`remember <text>\`")), true;
      const e = store.remember("user", uid, rest);
      await reply(message, `Got it. Remembered (id \`${e.id}\`).`);
      return true;
    }

    case "remember-channel": {
      if (!rest) return void (await reply(message, "Usage: \`remember-channel <text>\`")), true;
      const e = store.remember("channel", cid, rest);
      await reply(message, `Noted for this channel (id \`${e.id}\`).`);
      return true;
    }

    case "forget": {
      const id = rest.trim();
      if (!id) return void (await reply(message, "Usage: \`forget <id>\`")), true;
      const ok =
        store.forget("user", uid, id) || store.forget("channel", cid, id);
      await reply(message, ok ? `Forgot \`${id}\`.` : `No memory \`${id}\``);
      return true;
    }

    case "memories": {
      const u = store.list("user", uid);
      const c = store.list("channel", cid);
      const lines = [];
      lines.push(`**Your memories (${u.length}):**`);
      for (const e of u) lines.push(`\`${e.id}\` ${e.text}`);
      lines.push(`\n**Channel memories (${c.length}):**`);
      for (const e of c) lines.push(`\`${e.id}\` ${e.text}`);
      await reply(message, lines.join("\n") || "Nothing yet.");
      return true;
    }

    case "reset": {
      await withUserRunLock(uid, () => store.clearSession(cid));
      await reply(message, "Fresh session. Prior context dropped.");
      return true;
    }

    case "stop": {
      // Cancel in-flight turn and clear the pending FIFO queue (do not drain).
      const queue = userQueues.get(uid);
      if (!queue || queue.length === 0) {
        await reply(message, "No active or queued tasks.");
        return true;
      }

      const count = queue.length;
      const activeTask = queue[0];
      if (activeTask.abortController) {
         activeTask.abortController.abort();
      }
      const sessionId = store.getSession(activeTask.message.channelId);
      void abortSession(sessionId, uid);

      for (let i = 1; i < queue.length; i++) {
        const task = queue[i];
        if (task.thinking) {
          await task.thinking.edit({
            content: "❌ Request cancelled.",
            allowedMentions: { parse: [] },
          }).catch(() => {});
        }
        task.resolve();
      }

      queue.splice(1); // leave only in-flight; pending cleared (do not drain)
      console.log(`[queue] uid=${uid} stop cleared pending; aborting in-flight (was ${count})`);
      await reply(message, `🛑 Stopped all tasks (${count} request${count > 1 ? "s" : ""} cancelled).`);
      return true;
    }

    case "bg": {
      if (!rest) return void (await reply(message, "Usage: \`bg <command>\`")), true;
      try {
        const res = await runBackgroundTask(rest, uid);
        await reply(message, `🚀 Started background task:\n• **PID:** \`${res.pid}\`\n• **Log:** \`${res.logFile}\` (use \`!task-log ${res.logFile}\` to view logs)`);
      } catch (err) {
        await reply(message, `⚠️ Error: ${err.message}`);
      }
      return true;
    }

    case "exec":
    case "sh": {
      if (!rest) return void (await reply(message, "Usage: \`exec <command>\`")), true;
      try {
        await message.channel.sendTyping().catch(() => {});
        const res = await execCommand(rest, 30000, uid);
        const parts = [];
        if (res.stdout) parts.push(res.stdout.trim());
        if (res.stderr) parts.push(`stderr:\n${res.stderr.trim()}`);
        if (res.killed) parts.push(`(timed out)`);
        const text = parts.join("\n") || `(exit code ${res.exitCode}, no output)`;
        const icon = res.exitCode === 0 ? "✅" : "⚠️";
        const output = `${icon} Exit \`${res.exitCode}\`\`\`\n${text.slice(0, 1900)}\n\`\`\``;
        await reply(message, output);
      } catch (err) {
        await reply(message, `⚠️ Error: ${err.message}`);
      }
      return true;
    }

    case "tasks": {
      try {
        const res = await listBackgroundTasks(uid);
        const tasks = res.tasks || [];
        if (tasks.length === 0) {
          await reply(message, "No active background tasks running in the sandbox.");
          return true;
        }

        const embed = new EmbedBuilder()
          .setTitle("🏃 Active Background Tasks")
          .setDescription(tasks.map(t => {
            const shortCmd = t.cmd.length > 60 ? t.cmd.slice(0, 57) + "..." : t.cmd;
            return `\`\`${t.pid}\`\` | ${t.stat} | ${t.start} | \`${shortCmd}\``;
          }).join("\n"))
          .setColor(0x00ff99);

        const selectOptions = tasks.slice(0, 25).map(t => ({
          label: `PID ${t.pid}`,
          description: `${t.stat} | ${t.cmd.slice(0, 100)}`,
          value: String(t.pid),
        }));

        const row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("kill_select")
            .setPlaceholder("Select a process to kill...")
            .addOptions(selectOptions)
        );

        await message.reply({ embeds: [embed], components: [row] });
      } catch (err) {
        await reply(message, `⚠️ Error: ${err.message}`);
      }
      return true;
    }

    case "kill": {
      const pidStr = rest.trim();
      if (!pidStr) return void (await reply(message, "Usage: \`kill <pid>\`")), true;
      const pid = parseInt(pidStr);
      if (isNaN(pid)) return void (await reply(message, `Invalid PID: \`${pidStr}\``)), true;
      try {
        await killBackgroundTask(pid, uid);
        await reply(message, `🛑 Successfully killed process \`${pid}\`.`);
      } catch (err) {
        await reply(message, `⚠️ Error: ${err.message}`);
      }
      return true;
    }

    case "task-log": {
      const filename = rest.trim();
      if (!filename) return void (await reply(message, "Usage: \`task-log <filename>\`")), true;

      if (filename.includes("/") || filename.includes("..")) {
        return void (await reply(message, "Invalid filename. Logs must be located directly in the workspace.")), true;
      }

      try {
        const file = await getFile(filename, uid);
        const logContent = file.buffer.toString("utf8");
        const lines = logContent.trim().split("\n");
        const tail = lines.slice(-20).join("\n");

        await reply(message, `📄 **Log Tail for \`${filename}\` (last 20 lines):**\n\`\`\`\n${tail || "(empty)"}\n\`\`\``);
      } catch (err) {
        await reply(message, `⚠️ Error fetching log: ${err.message}`);
      }
      return true;
    }

    case "logs": {
      const parts = rest.trim().split(/\s+/).filter(Boolean);
      if (parts[0] === "status") {
        try {
          await reply(message, logs.fetchLogStatus(uid));
        } catch (err) {
          await reply(message, `⚠️ ${err.message}`);
        }
        return true;
      }
      let source = "all";
      let lineCount = 30;
      for (const p of parts) {
        if (["all", "supervisor", "serve", "activity"].includes(p)) source = p;
        else if (/^\d+$/.test(p)) lineCount = Math.min(100, parseInt(p, 10));
      }
      try {
        const result = await logs.fetchLogs(uid, { source, lines: lineCount });
        const formatted = logs.formatLogReply(result.lines, result.title);
        const running = result.running ? "✅" : "❌";
        await message.reply({
          content: `**${result.sandbox}** ${running}\n${formatted.content}`,
          files: formatted.truncated
            ? [{ attachment: Buffer.from(formatted.fullText, "utf8"), name: "logs.txt" }]
            : undefined,
        });
      } catch (err) {
        await reply(message, `⚠️ ${err.message}`);
      }
      return true;
    }

    case "setup": {
      if (!message.guild) {
        return void (await reply(message, "Setup can only be used in a server.")), true;
      }
      try {
        const text = settings.lockChannel(
          message.guild.id,
          message.channelId,
          PREFIX,
          client.user.username,
        );
        await reply(message, `✅ ${text}`);
      } catch (err) {
        await reply(message, `⚠️ ${err.message}`);
      }
      return true;
    }

    case "forget-channel": {
      if (!message.guild) {
        return void (await reply(message, "This command only works in a server.")), true;
      }
      await reply(message, `✅ ${settings.unlockChannel(message.guild.id)}`);
      return true;
    }

    case "settings": {
      try {
        const text = await settings.handleSettingsPrefix(message, rest, settingsDeps());
        await reply(message, text);
      } catch (err) {
        await reply(message, `⚠️ ${err.message}`);
      }
      return true;
    }

    case "remind": {
      if (!rest) return void (await reply(message, `Usage: \`${PREFIX}remind <when> <text>\` — e.g. \`${PREFIX}remind 30m take meds\``)), true;
      try {
        const zone = userTimeZone(uid);
        const { when, text } = splitWhenAndText(rest, zone);
        await createRoutineReply(message, {
          ...routineContextFromMessage(message),
          type: "message",
          payload: text,
          timezone: zone,
          schedule: { kind: "once", at: routines.parseTime(when, new Date(), zone) },
        });
      } catch (err) {
        await reply(message, `⚠️ ${err.message}`);
      }
      return true;
    }

    case "routine": {
      const [sub, ...tail] = rest.split(/\s+/);
      const tailRest = tail.join(" ").trim();

      if (sub === "history") {
        const entries = routines.listHistory(uid, tailRest || null, 15);
        if (entries.length === 0) {
          await reply(message, "No routine history.");
        } else {
          const lines = entries.map((entry) => {
            const icon = entry.status === "succeeded" ? "✅" : entry.status === "failed" ? "❌" : "⏳";
            const error = entry.error ? ` — ${entry.error.slice(0, 180)}` : "";
            return `${icon} \`${entry.routineId}\` attempt ${entry.attempt} ${new Date(entry.startedAt).toLocaleString()}${error}`;
          });
          await reply(message, `**Routine history:**\n${lines.join("\n")}`);
        }
        return true;
      }

      if (sub === "remove") {
        const id = tailRest.trim();
        if (!id) return void (await reply(message, `Usage: \`${PREFIX}routine remove <id>\``)), true;
        const ok = routines.removeRoutine(id, uid);
        await reply(message, ok ? `Removed routine \`${id}\`.` : `No routine \`${id}\` found.`);
        return true;
      }

      if (sub === "pause" || sub === "resume") {
        const id = tailRest.trim();
        if (!id) return void (await reply(message, `Usage: \`${PREFIX}routine ${sub} <id>\``)), true;
        const r = routines.setRoutineEnabled(id, uid, sub === "resume");
        await reply(message, r ? `${sub === "pause" ? "Paused" : "Resumed"} routine \`${id}\`.` : `No routine \`${id}\` found.`);
        return true;
      }

      if (sub === "daily") {
        if (!tailRest) return void (await reply(message, `Usage: \`${PREFIX}routine daily <time> <text>\` — e.g. \`${PREFIX}routine daily 9am standup\``)), true;
        try {
          const zone = userTimeZone(uid);
          const { when, text } = splitWhenAndText(tailRest, zone);
          await createRoutineReply(message, {
            ...routineContextFromMessage(message),
            type: "message",
            payload: text,
            timezone: zone,
            schedule: routines.parseDailyTime(when, zone),
          });
        } catch (err) {
          await reply(message, `⚠️ ${err.message}`);
        }
        return true;
      }

      if (sub === "every") {
        const intervalMatch = tailRest.match(/^(\d+\s*(?:m|min|mins|minute|minutes|h|hr|hrs|hour|hours))\s+(.+)$/i);
        if (!intervalMatch) {
          return void (await reply(message, `Usage: \`${PREFIX}routine every <interval> <text>\` — e.g. \`${PREFIX}routine every 6h check disk\``)), true;
        }
        try {
          await createRoutineReply(message, {
            ...routineContextFromMessage(message),
            type: "message",
            payload: intervalMatch[2].trim(),
            timezone: userTimeZone(uid),
            schedule: routines.parseEveryInterval(intervalMatch[1]),
          });
        } catch (err) {
          await reply(message, `⚠️ ${err.message}`);
        }
        return true;
      }

      if (sub === "auto") {
        if (!tailRest) return void (await reply(message, `Usage: \`${PREFIX}routine auto <when> <prompt>\` — e.g. \`${PREFIX}routine auto 2m summarize /work\``)), true;
        try {
          const zone = userTimeZone(uid);
          const { when, text } = splitWhenAndText(tailRest, zone);
          await createRoutineReply(message, {
            ...routineContextFromMessage(message),
            type: "llm",
            payload: text,
            timezone: zone,
            schedule: { kind: "once", at: routines.parseTime(when, new Date(), zone) },
          });
        } catch (err) {
          await reply(message, `⚠️ ${err.message}`);
        }
        return true;
      }

      await reply(message, `Usage:\n\`${PREFIX}routine list\` — list routines\n\`${PREFIX}routine history [id]\` — recent runs/errors\n\`${PREFIX}routine remove <id>\`\n\`${PREFIX}routine pause/resume <id>\`\n\`${PREFIX}routine daily <time> <text>\`\n\`${PREFIX}routine every <interval> <text>\`\n\`${PREFIX}routine auto <when> <prompt>\``);
      return true;
    }

    default:
      return false;
  }
}


client.once(Events.ClientReady, async (c) => {
  console.log(`punch online as ${c.user.tag}`);
  reloadSandboxMap();

  // Photon / Spectrum: auto-start when SPECTRUM_* is configured (same process as Discord).
  try {
    const { startSpectrumAlongsideBot } = await import("./spectrum/boot.js");
    await startSpectrumAlongsideBot();
  } catch (err) {
    console.error(
      "[spectrum] failed to boot alongside Discord:",
      err && err.message ? err.message : String(err),
    );
  }

  // Boot all dynamic sandboxes on startup
  for (const u of sandbox.loadUsers()) {
    const up = await sandbox.composeUp(u.name);
    if (up.ok) {
      console.log(`[sandbox] booted sandbox-${u.name}`);
    } else {
      console.error(`[sandbox] failed to boot sandbox-${u.name}: ${up.error}`);
    }
  }

  let slashCmd = [{
    name: "env",
    description: "Manage sandbox environment variables (hidden from others)",
    options: [
      { type: 1, name: "set", description: "Set an env var",
        options: [
          { type: 3, name: "key", description: "Variable name", required: true },
          { type: 3, name: "value", description: "Variable value", required: true },
        ] },
      { type: 1, name: "list", description: "List all env var keys" },
      { type: 1, name: "delete", description: "Delete an env var",
        options: [
          { type: 3, name: "key", description: "Variable name", required: true },
        ] },
    ],
  }, {
    name: "sandbox",
    description: "Manage sandbox users (create/list/remove)",
    options: [
      { type: 1, name: "create", description: "Create a new sandbox for a user",
        options: [
          { type: 3, name: "name", description: "Short name (e.g. ember)", required: true },
          { type: 3, name: "userid", description: "Discord user ID", required: true },
        ] },
      { type: 1, name: "list", description: "List all sandbox users" },
      { type: 1, name: "remove", description: "Remove a sandbox user",
        options: [
          { type: 3, name: "name", description: "User name to remove", required: true },
        ] },
    ],
  }, {
    name: "collab",
    description: "Create and inspect two-agent code reviews",
    options: [
      { type: 1, name: "create", description: "Create a shared Git review flow",
        options: [
          { type: 3, name: "reviewer", description: "Other sandbox name", required: true },
          { type: 3, name: "workspace", description: "Your existing Git repo under /work", required: true },
        ] },
      { type: 1, name: "start", description: "Initialize Git and start a two-agent coding task",
        options: [
          { type: 3, name: "reviewer", description: "Other sandbox name", required: true },
          { type: 3, name: "workspace", description: "Project directory under /work", required: true },
          { type: 3, name: "task", description: "Task sent to other agent", required: true },
        ] },
      { type: 1, name: "status", description: "List your collaborations" },
    ],
  }, {
    name: "skills",
    description: "Manage Markdown instruction skills in your sandbox",
    options: [
      { type: 1, name: "list", description: "List instruction skills and requirements" },
      { type: 1, name: "inspect", description: "Inspect a skill",
        options: [{ type: 3, name: "name", description: "Skill name", required: true }] },
      { type: 1, name: "enable", description: "Enable a skill",
        options: [{ type: 3, name: "name", description: "Skill name", required: true }] },
      { type: 1, name: "disable", description: "Disable a skill",
        options: [{ type: 3, name: "name", description: "Skill name", required: true }] },
      { type: 1, name: "proposals", description: "List pending generated-skill proposals" },
      { type: 1, name: "approve", description: "Review and install a proposed skill",
        options: [{ type: 3, name: "id", description: "Proposal id", required: true }] },
      { type: 1, name: "reject", description: "Reject a proposed skill",
        options: [{ type: 3, name: "id", description: "Proposal id", required: true }] },
    ],
  }, {
    name: "extensions",
    description: "Manage Pi extensions (code tools) in your sandbox",
    options: [
      { type: 1, name: "list", description: "List all extensions with status" },
      { type: 1, name: "disable", description: "Disable an extension (requires restart)",
        options: [{ type: 3, name: "name", description: "Extension filename", required: true }] },
      { type: 1, name: "enable", description: "Re-enable a disabled extension (requires restart)",
        options: [{ type: 3, name: "name", description: "Extension filename", required: true }] },
    ],
  }, {
    name: "multitask",
    description: "Run parallel subtasks while main chat is busy",
    options: [
      { type: 1, name: "on", description: "Enable automatic multitasking" },
      { type: 1, name: "off", description: "Disable automatic multitasking (queue messages)" },
      { type: 1, name: "status", description: "Show multitask setting and active workers" },
      { type: 1, name: "start", description: "Start a background subtask now",
        options: [
          { type: 3, name: "prompt", description: "Task for the subagent", required: true },
          { type: 3, name: "kind", description: "Worker capability",
            choices: [{ name: "research", value: "research" }, { name: "coding", value: "coding" }, { name: "browser", value: "browser" }] },
          { type: 3, name: "model", description: "Optional model override" },
          { type: 4, name: "timeout_minutes", description: "1-30; default 10" },
        ] },
      {
        type: 2,
        name: "settings",
        description: "Worker concurrency settings",
        options: [
          { type: 1, name: "view", description: "Show worker cap and active count" },
          {
            type: 1,
            name: "cap-set",
            description: "Set max concurrent workers (1-10)",
            options: [{ type: 4, name: "cap", description: "Max concurrent workers", required: true, min_value: 1, max_value: 10 }],
          },
        ],
      },
    ],
  }, {
    name: "workers",
    description: "Manage isolated Pi background workers",
    options: [
      { type: 1, name: "start", description: "Start isolated research, coding, or browser worker",
        options: [
          { type: 3, name: "kind", description: "Worker capability", required: true, choices: [{ name: "research", value: "research" }, { name: "coding", value: "coding" }, { name: "browser", value: "browser" }] },
          { type: 3, name: "prompt", description: "Worker task", required: true },
          { type: 3, name: "model", description: "Optional cheaper model" },
          { type: 4, name: "timeout_minutes", description: "1-30; default 10" },
        ] },
      { type: 1, name: "list", description: "List worker runs" },
      { type: 1, name: "stop", description: "Stop a worker", options: [{ type: 3, name: "id", description: "Worker id", required: true }] },
      { type: 1, name: "logs", description: "View worker log", options: [{ type: 3, name: "id", description: "Worker id", required: true }]     },
    ],
  }, {
    name: "models",
    description: "View or change your sandbox's AI model",
  }, {
    name: "apikey",
    description: "Set or remove an API key for an AI provider in your sandbox",
    options: [
      { type: 3, name: "provider", description: "Provider: anthropic, openai, google, opencode (Zen), etc.", required: true },
      { type: 3, name: "key", description: "API key (omit to remove the key)" },
    ],
  }, {
    name: "trigger",
    description: "Set a personal trigger word so Punch responds when you say it",
    options: [
      { type: 1, name: "set", description: "Set your personal trigger word",
        options: [{ type: 3, name: "word", description: "The word that summons Punch for you", required: true }] },
      { type: 1, name: "clear", description: "Remove your personal trigger word" },
    ],
  }, {
    name: "routine",
    description: "Schedule reminders and automations",
    options: [
      { type: 1, name: "add", description: "Add a routine",
        options: [
          { type: 3, name: "type", description: "Reminder message or LLM automation", required: true,
            choices: [{ name: "message", value: "message" }, { name: "llm", value: "llm" }, { name: "heartbeat", value: "heartbeat" }] },
          { type: 3, name: "when", description: "When to run (e.g. 30m, tomorrow 9am)", required: true },
          { type: 3, name: "text", description: "Reminder text or LLM prompt", required: true },
          { type: 3, name: "recurrence", description: "Recurrence pattern",
            choices: [
              { name: "once", value: "once" },
              { name: "daily", value: "daily" },
              { name: "weekly", value: "weekly" },
            ] },
          { type: 3, name: "timezone", description: "IANA timezone, e.g. America/New_York" },
          { type: 4, name: "active_start", description: "Optional active hour start (0-23)" },
          { type: 4, name: "active_end", description: "Optional active hour end (0-23)" },
          { type: 5, name: "isolated_session", description: "LLM routine starts fresh Pi session" },
        ] },
      { type: 1, name: "history", description: "View recent routine runs and errors",
        options: [{ type: 3, name: "id", description: "Optional routine id" }] },
      { type: 1, name: "remove", description: "Remove a routine",
        options: [{ type: 3, name: "id", description: "Routine id", required: true }] },
      { type: 1, name: "pause", description: "Pause a routine",
        options: [{ type: 3, name: "id", description: "Routine id", required: true }] },
      { type: 1, name: "resume", description: "Resume a routine",
        options: [{ type: 3, name: "id", description: "Routine id", required: true }] },
    ],
  }, {
    name: "remind",
    description: "Quick one-shot reminder in this channel",
    options: [
      { type: 3, name: "when", description: "When to remind (e.g. 30m, tomorrow 9am)", required: true },
      { type: 3, name: "message", description: "Reminder text", required: true },
    ],
  }, {
    name: "memory",
    description: "Search, view, export, or compact your Punch memory",
    options: [
      { type: 1, name: "view", description: "Show your sandbox's .punch-memory.md contents" },
      { type: 1, name: "search", description: "Find relevant stored memory",
        options: [{ type: 3, name: "query", description: "What to remember", required: true }] },
      { type: 1, name: "explain", description: "Show why memories matched",
        options: [{ type: 3, name: "query", description: "Search query", required: true }] },
      { type: 1, name: "compact", description: "Remove duplicate durable memories" },
      { type: 1, name: "export", description: "Download your durable user memories" },
      { type: 1, name: "import", description: "Import your durable memories from Punch export",
        options: [{ type: 11, name: "file", description: "JSON file from /memory export", required: true }] },
    ],
  }, {
    name: "doctor",
    description: "Diagnose your Punch sandbox and connected services",
    options: [
      { type: 3, name: "sandbox", description: "Sandbox name (Discord administrators only)" },
      { type: 5, name: "deep", description: "Run browser and filesystem probes" },
    ],
  }, {
    name: "logs",
    description: "View your sandbox and Pi gateway logs (ephemeral)",
    options: [
      { type: 1, name: "tail", description: "Show recent log lines",
        options: [
          { type: 3, name: "source", description: "Which logs to show",
            choices: [
              { name: "all (supervisor + serve)", value: "all" },
              { name: "supervisor", value: "supervisor" },
              { name: "Pi gateway", value: "serve" },
              { name: "turn activity", value: "activity" },
            ] },
          { type: 4, name: "lines", description: "Lines to show (default 30, max 100)" },
        ] },
      { type: 1, name: "status", description: "Sandbox health and recent events" },
    ],
  }, {
    name: "timeout",
    description: "Toggle idle/stale timeouts that abort hung Pi turns",
    options: [
      { type: 1, name: "disable", description: "Disable idle/stale timeouts for your turns (hard ceiling still applies)" },
      { type: 1, name: "enable", description: "Re-enable idle/stale timeouts (default)" },
      { type: 1, name: "status", description: "Show whether idle/stale timeouts are disabled" },
    ],
  }, {
    name: "reset",
    description: "Start a fresh Pi session in this channel (drops prior context)",
  }, {
    name: "botmode",
    description: "Experimental toggles: let bots trigger Punch, disable thinking message, or toggle git co-author",
    options: [
      { type: 1, name: "allow-bots", description: "Allow messages authored by bots to trigger Punch",
        options: [
          { type: 3, name: "state", description: "on / off / status", required: true,
            choices: [{ name: "on", value: "on" }, { name: "off", value: "off" }, { name: "status", value: "status" }] },
        ] },
      { type: 1, name: "no-thinking", description: "Disable the rotating 🤔 thinking message for your turns",
        options: [
          { type: 3, name: "state", description: "on / off / status", required: true,
            choices: [{ name: "on", value: "on" }, { name: "off", value: "off" }, { name: "status", value: "status" }] },
        ] },
      { type: 1, name: "show-context", description: "Always show a context-window % indicator under each reply",
        options: [
          { type: 3, name: "state", description: "on / off / status", required: true,
            choices: [{ name: "on", value: "on" }, { name: "off", value: "off" }, { name: "status", value: "status" }] },
        ] },
      { type: 1, name: "git-co-author", description: "Add Co-Authored-By: Punch trailer to git commits",
        options: [
          { type: 3, name: "state", description: "on / off / status", required: true,
            choices: [{ name: "on", value: "on" }, { name: "off", value: "off" }, { name: "status", value: "status" }] },
        ] },
      { type: 1, name: "auto-compress", description: "Prompt selective context pruning at a threshold (50-75%, 0 to disable)",
        options: [
          { type: 4, name: "threshold", description: "Context % threshold (50-75, 0=off)", required: false, min_value: 0, max_value: 75 },
        ] },
    ],
  }, {
    name: "compress",
    description: "Compress (summarize) the conversation in this channel to free up context",
  }, {
    name: "mcp",
    description: "Manage MCP servers loaded into Pi",
    options: [
      { type: 1, name: "list", description: "List configured MCP servers" },
      { type: 1, name: "add", description: "Add a local or remote MCP server",
        options: [
          { type: 3, name: "name", description: "Unique MCP server name", required: true },
          { type: 3, name: "type", description: "local (command) or remote (URL)", required: true,
            choices: [{ name: "local", value: "local" }, { name: "remote", value: "remote" }] },
          { type: 3, name: "url", description: "Remote MCP URL (required for remote)" },
          { type: 3, name: "command", description: "Local command, space-separated (required for local, e.g. 'npx -y <pkg>')" },
          { type: 3, name: "key", description: "API key (Bearer auth for remote; env for local — use api_key_env to name it)" },
          { type: 3, name: "api_key_env", description: "Local env var name the MCP reads (default API_KEY)" },
          { type: 3, name: "api_key_header", description: "Remote header name for the key (default Authorization Bearer)" },
          { type: 3, name: "headers", description: "Remote headers JSON (non-auth headers only; use key for API keys)" },
          { type: 3, name: "environment", description: "Local env JSON (non-secret vars only)" },
        ] },
      { type: 1, name: "remove", description: "Remove an MCP server",
        options: [{ type: 3, name: "name", description: "MCP server name", required: true }] },
      { type: 1, name: "auth", description: "Set or rotate an MCP server's API key",
        options: [
          { type: 3, name: "name", description: "MCP server name", required: true },
          { type: 3, name: "key", description: "API key", required: true },
        ] },
      { type: 1, name: "logout", description: "Remove stored API key for an MCP server",
        options: [{ type: 3, name: "name", description: "MCP server name", required: true }] },
    ],
  }, {
    name: "heartbeat",
    description: "Schedule autonomous heartbeat automations (run in your sandbox, DM you results)",
    options: [
      { type: 1, name: "add", description: "Add a heartbeat automation",
        options: [
          { type: 3, name: "when", description: "Schedule (e.g. every 6h, daily 9am, every 30m)", required: true },
          { type: 3, name: "prompt", description: "What the agent should do each time", required: true },
        ] },
      { type: 1, name: "list", description: "List your heartbeat automations" },
      { type: 1, name: "remove", description: "Remove a heartbeat",
        options: [{ type: 3, name: "id", description: "Heartbeat ID", required: true }] },
      { type: 1, name: "pause", description: "Pause a heartbeat",
        options: [{ type: 3, name: "id", description: "Heartbeat ID", required: true }] },
      { type: 1, name: "resume", description: "Resume a heartbeat",
        options: [{ type: 3, name: "id", description: "Heartbeat ID", required: true }] },
      { type: 1, name: "history", description: "View recent autonomous activity" },
    ],
  }, {
    name: "statistics",
    description: "View your Punch usage analytics (messages, tokens, and more)",
  }, {
    name: "tailscale",
    description: "Manage your sandbox's Tailscale connection",
    options: [
      { type: 1, name: "key", description: "Set a Tailscale auth key and connect",
        options: [{ type: 3, name: "authkey", description: "Tailscale auth key (tskey-...)", required: true }] },
      { type: 1, name: "login", description: "Authenticate interactively via browser link" },
      { type: 1, name: "reauth", description: "Force re-authentication" },
      { type: 1, name: "status", description: "Check Tailscale connection status" },
      { type: 1, name: "down", description: "Disconnect Tailscale" },
    ],
  }, {
    name: "provider",
    description: "Manage custom LLM providers",
    options: [
      { type: 1, name: "add", description: "Add a custom provider",
        options: [
          { type: 3, name: "name", description: "Provider name (used for /apikey set <name>)", required: true },
          { type: 3, name: "endpoint", description: "Base URL (e.g. https://api.my-llm.com/v1)", required: true },
          { type: 3, name: "api", description: "API format",
            choices: [
              { name: "OpenAI Completions", value: "openai-completions" },
              { name: "OpenAI Chat", value: "openai-chat" },
            ] },
        ] },
      { type: 1, name: "edit", description: "Edit a custom provider's endpoint or API format",
        options: [
          { type: 3, name: "name", description: "Provider name", required: true },
          { type: 3, name: "endpoint", description: "New base URL" },
          { type: 3, name: "api", description: "New API format",
            choices: [
              { name: "OpenAI Completions", value: "openai-completions" },
              { name: "OpenAI Chat", value: "openai-chat" },
            ] },
        ] },
      { type: 1, name: "remove", description: "Remove a custom provider and its models",
        options: [{ type: 3, name: "name", description: "Provider name", required: true }] },
      { type: 1, name: "list", description: "List providers (built-in and custom)" },
      {
        type: 2, name: "model", description: "Manage models for a custom provider",
        options: [
          { type: 1, name: "add", description: "Add a model to a custom provider",
            options: [
              { type: 3, name: "provider", description: "Provider name", required: true },
              { type: 3, name: "model", description: "Model ID (e.g. my-model-v1)", required: true },
              { type: 3, name: "name", description: "Display name (defaults to prettified model ID)" },
              { type: 4, name: "context", description: "Context window size (default 128000)" },
              { type: 4, name: "max_tokens", description: "Max output tokens (default 4096)" },
              { type: 5, name: "reasoning", description: "Supports reasoning/thinking (default No)" },
            ] },
          { type: 1, name: "edit", description: "Edit a model's details via modal",
            options: [
              { type: 3, name: "provider", description: "Provider name", required: true },
              { type: 3, name: "model", description: "Model ID", required: true },
            ] },
          { type: 1, name: "remove", description: "Remove a model from a custom provider",
            options: [
              { type: 3, name: "provider", description: "Provider name", required: true },
              { type: 3, name: "model", description: "Model ID to remove", required: true },
            ] },
          { type: 1, name: "list", description: "List models for a custom provider",
            options: [
              { type: 3, name: "provider", description: "Provider name", required: true },
            ] },
        ],
      },
    ],
  }, settings.getSlashCommandDefinition()];

  try {
    const rest = new REST({ version: "10" }).setToken(TOKEN);
    // Guild-only registration updates instantly (global can lag ~1h). Clear global
    // copies so Discord does not show each command twice.
    await rest.put(Routes.applicationCommands(c.user.id), { body: [] });
    for (const g of c.guilds.cache.values()) {
      await rest.put(Routes.applicationGuildCommands(c.user.id, g.id), { body: slashCmd });
    }
    console.log(`Registered ${slashCmd.length} slash commands in ${c.guilds.cache.size} guild(s)`);
  } catch (err) {
    console.error("Failed to register slash commands:", err.message);
  }

  routines.startScheduler(fireRoutine);
});

const userQueues = new Map();
/** Serialize all runAgent calls per user (chat + routines/heartbeat share one Pi). */
const userRunChains = new Map();
/** True while a FIFO drain loop is active for that user (prevents parallel drains). */
const userQueueDraining = new Set();

async function withUserRunLock(uid, fn) {
  const prev = userRunChains.get(uid) || Promise.resolve();
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  userRunChains.set(
    uid,
    prev.catch(() => {}).then(() => gate),
  );
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

async function enqueueChat(message, text, contextMessages = [], opts = {}) {
  const uid = opts.userId ?? message.author.id;

  if (shouldUseMultitaskWorker(uid, opts)) {
    const spawned = await trySpawnMultitaskWorker(message, text, contextMessages, opts);
    if (spawned) return;
  }

  if (!userQueues.has(uid)) {
    userQueues.set(uid, []);
  }
  const queue = userQueues.get(uid);

  let resolveQueue;
  const queuedPromise = new Promise((resolve) => {
    resolveQueue = resolve;
  });

  const abortController = new AbortController();

  const task = {
    message,
    text,
    contextMessages,
    opts,
    resolve: resolveQueue,
    thinking: null,
    abortController,
  };

  queue.push(task);
  const depth = queue.length;
  console.log(`[queue] uid=${uid} enqueue depth=${depth}`);

  if (depth > 1) {
    // N = how many requests are ahead (in-flight + earlier queued).
    const ahead = depth - 1;
    task.thinking = await message
      .reply({
        content: `⏳ queued (${ahead})`,
        allowedMentions: { parse: [], repliedUser: false },
      })
      .catch(() => null);
  }

  // Ensure a single FIFO drain is running (or will re-check after the current one).
  void processQueue(uid);

  await queuedPromise;
}

async function processQueue(uid) {
  if (userQueueDraining.has(uid)) return;
  userQueueDraining.add(uid);

  try {
    // Drain FIFO one turn at a time. Chat holds the queue slot for the full
    // handleChat; withUserRunLock inside still serializes with routines/heartbeat.
    for (;;) {
      const queue = userQueues.get(uid);
      if (!queue || queue.length === 0) break;

      const task = queue[0];
      console.log(`[queue] uid=${uid} run depth=${queue.length}`);
      try {
        await handleChat(
          task.message,
          task.text,
          task.contextMessages || [],
          task.thinking,
          task.abortController.signal,
          task.opts || {},
        );
      } catch (err) {
        console.error(`[queue] Error running task for user ${uid}:`, err);
      } finally {
        queue.shift();
        task.resolve();
      }
    }
  } finally {
    userQueueDraining.delete(uid);
    // Sync section: if something enqueued after the loop emptied, restart drain.
    const queue = userQueues.get(uid);
    if (queue && queue.length > 0) {
      void processQueue(uid);
    } else if (queue) {
      userQueues.delete(uid);
    }
  }
}

function setCurrentUserId(uid) {
  try {
    writeFileSync("/state/current_user", String(uid));
  } catch (err) {
    console.error(`Failed to set current user: ${err.message}`);
  }
}

// Returns the attribution subtext for a punch reply, e.g. "\n\n-# from sandbox:ember".
// Applied at the OUTPUT layer so it survives message chunking and pigeon routing.
function labelLineFor(userId) {
  const name = sandboxNameForUser(userId);
  return name ? `\n\n-# from sandbox:${name}` : "";
}

// Durable project memory (.punch-memory.md) kept inside the user's sandbox.
// Injected per turn as part of the unified memory block; missing/unreachable
// sandbox yields "" and the turn proceeds with related memory only.
async function fetchProjectMemory(uid) {
  try {
    const file = await getFile("/work/.punch-memory.md", uid);
    const text = file.buffer.toString("utf8").trim().slice(0, 12_000);
    return text || "";
  } catch {
    return "";
  }
}

async function handleChat(message, text, contextMessages = [], existingThinking = null, signal = null, opts = {}) {
  const uid = opts.userId ?? message.author.id;
  const turn = { startedAt: Date.now(), phase: "starting", detail: "checking sandbox" };
  activeTurns.set(uid, turn);

  // Ensure this user has their own sandbox workspace
  const sandboxUrl = await ensureUserSandbox(uid);
  if (!sandboxUrl) {
    const mapped = !!apiUrlFor(uid);
    const msg = mapped
      ? "Your sandbox is unreachable. It might be restarting — try again in a few seconds."
      : "You don't have a sandbox yet. Ask an admin to set one up with `/sandbox create <name>` and `/sandbox map @you <name>`.";
    if (existingThinking) {
      await existingThinking.edit({ content: msg, allowedMentions: { parse: [] } }).catch(() => {});
    } else {
      await reply(message, msg);
    }
    activeTurns.delete(uid);
    return;
  }

  // Discord voice memos → transcript, then treat as normal chat text.
  if (isVoiceMessage(message)) {
    turn.phase = "transcribing";
    turn.detail = "transcribing voice memo";
    if (existingThinking) {
      await existingThinking.edit({
        content: "🎧 Transcribing voice memo…",
        allowedMentions: { parse: [] },
      }).catch(() => {});
    }
    const stt = await transcribeVoiceMessage(message, {
      resolveConfig: () => resolveSttConfigForUser(uid),
      signal,
    });
    if (stt.aborted || signal?.aborted) {
      await discardThinkingMessage(existingThinking);
      activeTurns.delete(uid);
      return;
    }
    if (!stt.ok) {
      if (stt.error) console.error(`[stt] uid=${uid} ${stt.error}`);
      const errMsg = stt.userError || STT_USER_ERROR_GENERIC;
      if (existingThinking) {
        await existingThinking.edit({ content: errMsg, allowedMentions: { parse: [] } }).catch(() => {});
      } else {
        await reply(message, errMsg);
      }
      activeTurns.delete(uid);
      return;
    }
    if (stt.text) {
      text = mergeTranscriptIntoText(text, stt.text);
      console.log(`[stt] uid=${uid} transcribed ${stt.text.length} chars`);
    }
  }

  const cid = message.channelId;
  const memoryUserText = text;

  // Gather message attachments (triggering message + any replied-to message)
  // and prepare attachments so the model can read them in the sandbox.
  const skippedAttach = [];
  let agentAttachments = await downloadMessageAttachments(message);
  skippedAttach.push(...agentAttachments.skipped);
  agentAttachments = agentAttachments.attachments;
  if (message.reference?.messageId) {
    try {
      const refMsg = await message.channel.messages.fetch(message.reference.messageId);
      if (refMsg) {
        const r = await downloadMessageAttachments(refMsg);
        agentAttachments = agentAttachments.concat(r.attachments);
        skippedAttach.push(...r.skipped);
      }
    } catch (err) {
      console.error("[attachments] failed to fetch replied message attachments:", err.message);
    }
  }

  // Persist each attachment into the sandbox workspace so the model can read it
  // with its file tools (text for docs/SVG, vision for images). Inline `file`
  // inline file parts are rejected by the gateway, so we save to disk and reference the path.
  const workspaceFiles = [];
  for (const att of agentAttachments) {
    if (!att.data) continue;
    const wp = await uploadToSandbox(uid, att.filename || "file", Buffer.from(att.data, "base64")).catch(() => null);
    if (wp) workspaceFiles.push({ name: att.filename || "file", path: wp });
  }

  if (agentAttachments.length) {
    const names = agentAttachments.map((a) => a.filename).filter(Boolean).join(", ");
    text += `\n\n[Attached ${agentAttachments.length} file(s) for you to read/parse: ${names}]`;
  }
  if (workspaceFiles.length) {
    const list = workspaceFiles.map((f) => `- ${f.name} -> ${f.path}`).join("\n");
    text +=
      `\n\n[The attached file(s) above were saved into your sandbox workspace. ` +
      `Read them with your file-reading tools to parse/inspect them:\n${list}]`;
  }

  if (!text.trim() && agentAttachments.length === 0) {
    if (existingThinking) {
      await existingThinking.edit({
        content: "Say something after the mention (or send a voice memo).",
        allowedMentions: { parse: [] },
      }).catch(() => {});
    } else {
      await reply(message, "Say something after the mention (or send a voice memo).");
    }
    activeTurns.delete(uid);
    return;
  }

  const who = opts.displayName ?? (message.member?.displayName || message.author.username);
  const speakerName = opts.speakerUsername ?? message.author.username;
  const speaker = `${who} (@${speakerName}, id:${uid})`;
  const isDirectMessage = !message.guildId;

  const { useLifecycle, useThinking } = progressSettingsFor(message);

  const projectMemory = await fetchProjectMemory(uid);

  const preambleParts = [];
  const sentAt = formatMessageTimestamp(message.createdTimestamp, store.getUserSettings(uid).timeZone);
  if (sentAt) {
    preambleParts.push(timestampLine(sentAt));
  }
  preambleParts.push(thisTurnInstructions());
  if (opts.reactedTo) preambleParts.push(opts.reactedTo);
  if (opts.repliedTo) preambleParts.push(opts.repliedTo);
  if (opts.pigeonFrom) {
    const sbName = opts.sandboxName || sandbox.loadUsers().find((u) => u.userId === uid)?.name;
    preambleParts.push(pigeonTurnPreamble(opts.pigeonFrom, opts.pigeonHop ?? 0, sbName));
  }
  if (contextMessages.length > 0) preambleParts.push(channelContextBlock(contextMessages));

  let thinking = existingThinking;
  const allowThinking = useThinking && !store.getUserSettings(uid).noThinking;
  const startedAt = Date.now();
  let progressState = createProgressState(startedAt);
  let progressRenderer = null;
  let memoryRecallKey = null;
  let memoryRecallAdopted = false;

  if (allowThinking) {
    const initial = renderProgressLive(progressState, startedAt);
    if (thinking) {
      await thinking.edit({ content: initial, allowedMentions: { parse: [] } }).catch(() => {});
    } else {
      thinking = await message
        .reply({
          content: initial,
          allowedMentions: { parse: [], repliedUser: false },
        })
        .catch(() => null);
    }
    if (thinking) {
      progressRenderer = createProgressRenderer({
        initialState: progressState,
        edit: (options) => thinking.edit(options),
        finalSuffix: labelLineFor(uid),
      });
    }
  } else if (thinking) {
    await thinking.delete().catch(() => {});
    thinking = null;
  }

  if (useLifecycle) {
    await safeReact(message, LIFECYCLE_PROGRESS_EMOJI);
  }
  message.channel.sendTyping().catch(() => {});
  const typing = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);

  const onProgress = (ev) => {
    progressState = progressRenderer
      ? progressRenderer.update(ev)
      : reduceProgressEvent(progressState, ev, Date.now());
    turn.phase = progressState.phase;
    turn.detail = progressState.current;
  };

  const finalizeProgress = async (activity, fallbackStatus, result = "", rich = {}) => {
    if (progressRenderer) {
      await progressRenderer.finalize(activity, fallbackStatus, result, rich);
      progressState = progressRenderer.getState();
    } else if (thinking) {
      await thinking.delete().catch(() => {});
      thinking = null;
    }
  };

  try {
    turn.phase = "thinking";
    turn.detail = "waiting for Pi";
    let compressed = false;
    const res = await withUserRunLock(uid, async () => {
      const currentSession = store.getSession(cid);
      // New sessions get a temporary recall key until Pi returns a session ID.
      memoryRecallKey = currentSession || `pending:${uid}:${cid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      const pre = store.preamble(uid, cid, memoryUserText, {
        isDm: isDirectMessage,
        maxChars: 1_200,
        limit: 3,
        recallSessionId: memoryRecallKey,
      });
      const memory = memoryBlock({ projectMemory, relatedText: pre });
      if (memory) preambleParts.push(memory);
      const prompt = assemblePrompt(
        preambleParts,
        userTurnLine(uid, speaker, text, { channelId: cid, timeZone: store.getUserSettings(uid).timeZone }),
      );
      console.log(`[chat] uid=${uid} cid=${cid} session=${currentSession || "new"} -> pi`);
      const result = await runAgent(prompt, currentSession, onProgress, signal, uid, agentAttachments);
      store.moveMemoryRecall(memoryRecallKey, result.sessionId);
      memoryRecallAdopted = true;
      store.setSession(cid, result.sessionId);
      if (result.sessionId && /<\/?compress\s*\/?\s*>/i.test(result.text)) {
        try {
          await summarizeSession(result.sessionId, uid, signal);
          store.clearMemoryRecall(result.sessionId);
          compressed = true;
        } catch (error) {
          console.error(`[compress] model-requested failed:`, error.message);
        }
      }
      return result;
    });
    console.log(`[chat] uid=${uid} cid=${cid} reply len=${res.text.length}`);

    const filesToSend = [];

    const { clean: textAfterMemory, saved, dropped } = persistMemoryTags(res.text, uid, cid);
    const { clean: textAfterAttachments, attachments } = extractAttachments(textAfterMemory);
    const { clean: textAfterReacts, emojis: reactEmojis } = extractReactTags(textAfterAttachments);
    const { clean: textAfterCompress, requested: compressRequested } = extractCompressTag(textAfterReacts);

    for (const relPath of attachments) {
      try {
        const f = await getFile(relPath, uid);
        pushFile(filesToSend, f.buffer, f.name);
      } catch (err) {
        console.error(`[attachments] fetch "${relPath}" failed:`, err.message);
      }
    }

    if (reactEmojis.length) {
      await applyReactTags(message, reactEmojis);
    }

    let out = textAfterCompress || "";
    if (out === "(no output)") out = "";
    if (opts.pigeonFrom) {
      out = scanOutbound(out).text;
    }

    const { clean: textAfterEmbeds, embeds, errors: embedErrors } = extractEmbeds(out);
    const { clean: textAfterQuestions, questions } = extractQuestions(textAfterEmbeds);
    out = textAfterQuestions || "";

    let capturedMemory = { notesAdded: 0, factsAdded: 0, facts: [] };
    if (isDirectMessage && !message.author.bot && !opts.pigeonFrom) {
      try {
        capturedMemory = store.captureConversation({
          userId: uid,
          channelId: cid,
          isDm: true,
          userText: memoryUserText,
          assistantText: out,
          extractDurableFacts: saved === 0,
        });
      } catch (error) {
        console.error(`[memory] capture failed uid=${uid}:`, error.message);
      }
    }

    const notes = [];
    if (saved) notes.push(`remembered ${saved}`);
    if (capturedMemory.factsAdded) notes.push(`auto-remembered ${capturedMemory.factsAdded}`);
    if (dropped) notes.push(`forgot ${dropped}`);
    const ctxNote = contextUsageNote(res.usage, uid);
    if (ctxNote) notes.push(ctxNote);
    if (compressed) notes.push("context compressed");
    if (agentAttachments.length) notes.push(`parsed ${agentAttachments.length} attachment(s)`);
    if (skippedAttach.length) notes.push(`skipped ${skippedAttach.length} file(s) over ${Math.round(MAX_ATTACHMENT_BYTES / 1048576)}MB`);
    if (oversizeNote(filesToSend)) notes.push(oversizeNote(filesToSend));
    if (embedErrors.length) notes.push(embedErrors.join("; "));
    if (notes.length) out += (out ? "\n\n" : "") + `_🧠 ${notes.join(", ")}_`;

    const sendable = filesToSend.filter((f) => !f.oversize);
    if (sendable.length > 1) console.log(`[attach-debug] WARNING: ${sendable.length} files in sendable: ${sendable.map((f) => `${f.name}(${f.attachment?.length})`).join(", ")}`);
    const hasText = Boolean(out.trim());
    const hasNotes = notes.length > 0;
    const reactionOnly =
      !hasText && !hasNotes && sendable.length === 0 &&
      reactEmojis.length > 0 && embeds.length === 0 && questions.length === 0;

    const label = labelLineFor(uid);
    const activityStatus = res.activity?.status || "completed";

    const hasResult = out.trim() || sendable.length > 0 || embeds.length > 0 || questions.length > 0;
    if (hasResult) {
      if (progressRenderer) {
        // Keep the answer and activity count in the original status message.
        // Discord's content limit still requires overflow replies for long answers.
        const [primary = "", ...overflow] = chunk(out, 1_650);
        await finalizeProgress(res.activity, activityStatus, primary, { files: sendable, embeds });
        if (overflow.length) await settle(message, overflow.join("") + label);
      } else {
        await settle(message, out + label, sendable, { embeds });
      }
      for (const q of questions) {
        await sendQuestion(message.channel, q, uid);
      }
    }
    if (!hasResult || !progressRenderer) {
      await finalizeProgress(res.activity, activityStatus);
    }

    if (useLifecycle) {
      const endEmoji = activityStatus === "completed" ? "✅" : activityStatus === "aborted" ? "🛑" : "⚠️";
      await finishLifecycleReact(message, endEmoji);
    }

    state.recordActivity({
      userId: uid, channelId: cid, type: "reactive",
      prompt: text.slice(0, 500),
      response: (out || "").slice(0, 2000),
      sessionId: res.sessionId,
      status: activityStatus === "completed" ? "success" : "error",
      duration: Date.now() - startedAt,
      ...statistics.tokenFieldsFromAgent(res),
    });

    if (opts.pigeonFrom) {
      await notifyPigeonDone({
        recipientUserId: uid,
        pigeonFrom: opts.pigeonFrom,
        pigeonHop: opts.pigeonHop ?? 0,
        sandboxName: opts.sandboxName || sandbox.loadUsers().find((u) => u.userId === uid)?.name,
        status: activityStatus === "completed" ? "done" : "failed",
        summary: out,
        error: activityStatus === "completed" ? "" : out,
        notifyPigeonDM,
      });
    }
  } catch (err) {
    console.error(`[chat] cid=${cid} ERROR:`, err?.stack || err?.message || err);
    if (memoryRecallKey && !memoryRecallAdopted) store.clearMemoryRecall(memoryRecallKey);
    const aborted = err.name === "AbortError" || /aborted|cancel/i.test(err.message);
    const timedOut = /timed out|timeout|stalled|ceiling|silent for|turn hung/i.test(err?.message || "");
    await finalizeProgress(null, aborted ? "aborted" : timedOut ? "timeout" : "error");
    if (useLifecycle) {
      const endEmoji = aborted ? "🛑" : "⚠️";
      await finishLifecycleReact(message, endEmoji);
    }
    if (aborted) {
      if (useThinking) {
        await settle(message, "❌ Request cancelled.").catch(() => {});
      }
      if (opts.pigeonFrom) {
        await notifyPigeonDone({
          recipientUserId: uid,
          pigeonFrom: opts.pigeonFrom,
          pigeonHop: opts.pigeonHop ?? 0,
          sandboxName: opts.sandboxName || sandbox.loadUsers().find((u) => u.userId === uid)?.name,
          status: "cancelled",
          notifyPigeonDM,
        });
      }
      state.recordActivity({
        userId: uid,
        channelId: cid,
        type: "reactive",
        prompt: text.slice(0, 500),
        response: String(err?.message || err).slice(0, 2000),
        sessionId: store.getSession(cid),
        status: "cancelled",
        duration: Date.now() - startedAt,
      });
      return;
    }
    let note = "";
    if (timedOut) {
      store.clearSession(cid);
      note = " (hung turn aborted + Pi restart requested — try again)";
    }
    // A previous session stored inline `file` parts (zip/jpg/etc.) that the
    // model now rejects. Clear the poisoned session so the next turn starts
    // fresh — we no longer send file parts (files live in /work/attachments).
    if (/file part media type|functionality not supported/i.test(err?.message || "")) {
      store.clearSession(cid);
      note = " (cleared a session with unsupported file parts — try again)";
    }
    if (useThinking) {
      await settle(message, `⚠️ ${err.message}${note}`).catch((e2) =>
        console.error(`[chat] cid=${cid} reply also failed:`, e2?.message || e2));
    }

    if (opts.pigeonFrom) {
      await notifyPigeonDone({
        recipientUserId: uid,
        pigeonFrom: opts.pigeonFrom,
        pigeonHop: opts.pigeonHop ?? 0,
        sandboxName: opts.sandboxName || sandbox.loadUsers().find((u) => u.userId === uid)?.name,
        status: "failed",
        error: `${err.message}${note}`,
        notifyPigeonDM,
      });
    }
    state.recordActivity({
      userId: uid,
      channelId: cid,
      type: "reactive",
      prompt: text.slice(0, 500),
      response: String(err?.message || err).slice(0, 2000),
      sessionId: store.getSession(cid),
      status: "error",
      duration: Date.now() - startedAt,
    });
  } finally {
    activeTurns.delete(uid);
    clearInterval(typing);
  }
}

const MAX_UPLOAD = Number(process.env.DISCORD_MAX_UPLOAD) || 8 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = (Number(process.env.OPENCODE_MAX_ATTACHMENT) || 10) * 1024 * 1024;

function pushFile(list, buffer, name) {
  if (!buffer || !buffer.length) return;
  list.push({ attachment: buffer, name, oversize: buffer.length > MAX_UPLOAD });
}

function oversizeNote(files) {
  const n = files.filter((f) => f.oversize).length;
  return n ? `skipped ${n} file${n > 1 ? "s" : ""} over ${Math.round(MAX_UPLOAD / 1048576)}MB` : "";
}

// Download a Discord message's attachments for sandbox delivery.
// Each returned item is { mime, filename, data } where `data` is base64.
async function downloadMessageAttachments(message) {
  const out = [];
  const skipped = [];
  const items = message?.attachments ? [...message.attachments.values()] : [];
  for (const att of items) {
    if (att.size > MAX_ATTACHMENT_BYTES) {
      skipped.push(att.name);
      continue;
    }
    try {
      const res = await fetch(att.url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) {
        console.error(`[attachments] download failed (${res.status}) for ${att.name}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      out.push({
        mime: att.contentType || "application/octet-stream",
        filename: att.name,
        data: buf.toString("base64"),
      });
    } catch (err) {
      console.error(`[attachments] download failed for ${att.name}:`, err.message);
    }
  }
  return { attachments: out, skipped };
}

// Write a downloaded attachment into the user's sandbox workspace so the agent
// can read/parse it with its file tools. Gateway message `file` parts do not
// accept inline data URLs (they 400), so we persist the bytes on disk and point
// the model at the path instead. Returns the workspace path or null on failure.
function sanitizeAttachName(n) {
  const base = String(n || "file").replace(/[\/\\]/g, "_").replace(/[^a-zA-Z0-9._-]/g, "_");
  return base.slice(0, 120) || "file";
}

async function uploadToSandbox(userId, filename, buffer) {
  const name = sandboxNameForUser(userId);
  if (!name) return null;
  const container = sandbox.containerForSandbox(name);
  if (!container) return null;
  const safe = sanitizeAttachName(filename);
  const tmp = join(tmpdir(), `punch_att_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  try {
    writeFileSync(tmp, buffer);
    sandbox.ensureDirInContainer(container, "/work/attachments");
    sandbox.copyIntoContainer(container, tmp, `/work/attachments/${safe}`);
    return `/work/attachments/${safe}`;
  } catch (e) {
    console.error("[attachments] sandbox upload failed:", e.message);
    return null;
  } finally {
    rmSync(tmp, { force: true });
  }
}

function extractAttachments(textIn) {
  const paths = [];
  const text = String(textIn || "");
  const ATTACHMENT_RE = /<attachment\s+path="([^"]+)"\s*\/?>?\s*(?:<\/attachment\s*>)?|<attachment\s*>([\s\S]*?)<\/attachment>/gi;
  const clean = text.replace(ATTACHMENT_RE, (match, p1, p2) => {
    const p = (p1 || p2 || "").trim();
    if (p) paths.push(p);
    return "";
  }).trim();
  return { clean, attachments: paths };
}

async function settle(message, text, files = [], rich = {}) {
  const embeds = rich.embeds || [];
  const parts = chunk(text);
  if (parts.length === 0) {
    if (files.length > 0 || embeds.length > 0) {
      await message.reply({
        files,
        embeds,
        allowedMentions: { parse: [], repliedUser: false },
      });
    }
  } else {
    for (let i = 0; i < parts.length; i++) {
      const options = {
        content: parts[i],
        allowedMentions: { parse: [], repliedUser: false },
      };
      if (i === 0) {
        if (files.length > 0) options.files = files;
        if (embeds.length > 0) options.embeds = embeds;
      }
      await message.reply(options);
    }
  }
}

const REMEMBER_RE =
  /<remember(?:\s+scope="(user|channel)")?(?:\s+id="(\d+)")?\s*>([\s\S]*?)<\/remember>/gi;
const FORGET_RE = /<forget\s+id="([^"]+)"\s*>\s*<\/forget>/gi;

function persistMemoryTags(textIn, speakerId, channelId) {
  let saved = 0;
  let dropped = 0;
  const text = String(textIn || "");

  for (const m of text.matchAll(REMEMBER_RE)) {
    const scope = (m[1] || "user").toLowerCase();
    const fact = m[3].trim();
    if (!fact) continue;
    if (scope === "channel") store.remember("channel", channelId, fact);
    else store.remember("user", m[2] || speakerId, fact);
    saved += 1;
  }

  for (const m of text.matchAll(FORGET_RE)) {
    const id = m[1].trim();
    if (store.forget("user", speakerId, id) || store.forget("channel", channelId, id)) {
      dropped += 1;
    }
  }

  const clean = text.replace(REMEMBER_RE, "").replace(FORGET_RE, "").trim();
  return { clean, saved, dropped };
}

// --- Sandbox-generated Discord embeds & interactive questions ---
// The model emits <embed>{json}</embed> and <question>...</question> tags. The bot
// strips them, renders Discord embeds, and (for questions) wires component clicks
// back into the same channel session as a new user turn.

const EMBED_RE = /<embed\s*>([\s\S]*?)<\/embed>/gi;
const QUESTION_RE = /<question\b([^>]*)>([\s\S]*?)<\/question>/gi;
const QUESTION_OPTION_RE = /^\s*(?:[-*•]|\d+[.)])\s+(.+?)\s*$/;

function buildEmbedFromJson(j) {
  if (!j || typeof j !== "object") return null;
  const e = new EmbedBuilder();
  if (j.title) e.setTitle(String(j.title).slice(0, 256));
  if (j.description) e.setDescription(String(j.description).slice(0, 4096));
  if (j.url) e.setURL(String(j.url));
  if (j.color !== undefined) {
    const c = Number(j.color);
    if (!Number.isNaN(c)) e.setColor(c);
  }
  if (j.author && typeof j.author === "object") {
    const a = { name: String(j.author.name || "").slice(0, 256) };
    if (j.author.url) a.url = String(j.author.url);
    if (j.author.icon_url) a.iconURL = String(j.author.icon_url);
    if (a.name) e.setAuthor(a);
  }
  if (j.thumbnail && j.thumbnail.url) e.setThumbnail(String(j.thumbnail.url));
  if (j.image && j.image.url) e.setImage(String(j.image.url));
  if (j.footer && typeof j.footer === "object") {
    const f = { text: String(j.footer.text || "").slice(0, 2048) };
    if (j.footer.icon_url) f.iconURL = String(j.footer.icon_url);
    if (f.text) e.setFooter(f);
  }
  if (Array.isArray(j.fields)) {
    for (const f of j.fields.slice(0, 25)) {
      if (f && f.name != null && f.value != null) {
        e.addFields({ name: String(f.name).slice(0, 256), value: String(f.value).slice(0, 1024), inline: !!f.inline });
      }
    }
  }
  if (j.timestamp) {
    const ts = new Date(j.timestamp);
    if (!Number.isNaN(ts.getTime())) e.setTimestamp(ts);
  }
  return e;
}

function extractEmbeds(textIn) {
  const embeds = [];
  const errors = [];
  const text = String(textIn || "").replace(EMBED_RE, (_m, body) => {
    try {
      const json = JSON.parse(body.trim());
      const e = buildEmbedFromJson(json);
      if (e) embeds.push(e);
    } catch (err) {
      errors.push(`embed JSON error: ${err.message}`);
    }
    return "";
  }).trim();
  return { clean: text, embeds, errors };
}

function parseQuestionAttrs(attrs) {
  const q = { title: null, description: null, multi: false, style: null, input: [] };
  const t = attrs.match(/title="([^"]*)"/i);
  if (t) q.title = t[1];
  const d = attrs.match(/description="([^"]*)"/i);
  if (d) q.description = d[1];
  if (/\bmulti\b/i.test(attrs)) q.multi = true;
  const s = attrs.match(/style="([^"]*)"/i);
  if (s) q.style = s[1].toLowerCase();
  const inp = attrs.match(/input="([^"]*)"/i);
  if (inp) q.input = inp[1].split(";").map((x) => x.trim()).filter(Boolean).slice(0, 5);
  return q;
}

function parseQuestionOptions(body) {
  const opts = [];
  for (const line of String(body).split(/\n/)) {
    const m = line.match(QUESTION_OPTION_RE);
    if (m) opts.push(m[1].trim());
  }
  return opts;
}

function extractQuestions(textIn) {
  const questions = [];
  const text = String(textIn || "").replace(QUESTION_RE, (_m, attrs, body) => {
    const q = parseQuestionAttrs(attrs);
    q.options = parseQuestionOptions(body);
    if (q.options.length === 0 && q.input.length === 0) return "";
    questions.push(q);
    return "";
  }).trim();
  return { clean: text, questions };
}

function buildQuestionComponents(q, messageId) {
  const opts = q.options.slice(0, 25);
  if (q.style === "checkbox") {
    const rows = [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`qchk:${messageId}`)
          .setLabel(("☑ " + (q.title || "Choose options")).slice(0, 80))
          .setStyle(ButtonStyle.Primary),
      ),
    ];
    if (q.input && q.input.length) {
      rows.push(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`qans:${messageId}`)
            .setLabel("✏️ Other…")
            .setStyle(ButtonStyle.Secondary),
        ),
      );
    }
    return rows;
  }
  const useSelect = q.style === "select" || q.multi || opts.length > 5;
  if (useSelect) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`qsel:${messageId}`)
      .setPlaceholder((q.title || "Choose an option").slice(0, 100))
      .addOptions(opts.map((o, i) => ({ label: o.slice(0, 100), value: `o${i}` })));
    if (q.multi) menu.setMinValues(1).setMaxValues(opts.length);
    return [new ActionRowBuilder().addComponents(menu)];
  }
  const rows = [];
  let row = new ActionRowBuilder();
  for (let i = 0; i < opts.length; i++) {
    if (row.components.length === 5) {
      rows.push(row);
      row = new ActionRowBuilder();
    }
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`qbtn:${messageId}:${i}`)
        .setLabel(opts[i].slice(0, 80))
        .setStyle(ButtonStyle.Primary),
    );
  }
  if (row.components.length) rows.push(row);
  if (q.input && q.input.length) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`qans:${messageId}`)
          .setLabel(opts.length > 0 ? "✏️ Other…" : "✏️ Answer")
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  }
  return rows;
}

const questionState = new Map();

function registerQuestionState(messageId, state) {
  questionState.set(messageId, state);
  if (questionState.size > 500) {
    const firstKey = questionState.keys().next().value;
    if (firstKey) questionState.delete(firstKey);
  }
}

async function sendQuestion(channel, q, fromUserId) {
  const embed = new EmbedBuilder();
  if (q.title) embed.setTitle(q.title.slice(0, 256));
  if (q.description) embed.setDescription(q.description.slice(0, 4096));
  embed.setColor(0x5865f2);
  const qmsg = await channel.send({
    embeds: [embed],
    allowedMentions: { parse: [] },
  }).catch(() => null);
  if (!qmsg) return;
  const components = buildQuestionComponents(q, qmsg.id);
  await qmsg.edit({ components }).catch(() => {});
  registerQuestionState(qmsg.id, {
    title: q.title,
    options: q.options.slice(0, 25),
    multi: !!q.multi,
    input: (q.input || []).slice(0, 5),
    fromUserId,
  });
}

async function handleQuestionInteraction(interaction) {
  const state = questionState.get(interaction.message.id);
  if (!state) {
    await interaction.reply({ content: "That question is no longer active.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  if (interaction.user.bot) return;

  let chosen = [];
  if (interaction.isButton()) {
    const idx = Number(interaction.customId.split(":")[2]);
    if (!Number.isNaN(idx) && state.options[idx] != null) chosen = [state.options[idx]];
  } else if (interaction.isStringSelectMenu()) {
    for (const v of interaction.values) {
      const idx = Number(String(v).replace(/^o/, ""));
      if (!Number.isNaN(idx) && state.options[idx] != null) chosen.push(state.options[idx]);
    }
  }
  if (chosen.length === 0) {
    await interaction.reply({ content: "Invalid selection.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }

  // Remove components so the question can't be answered twice.
  await interaction.update({ components: [] }).catch(() => {});
  questionState.delete(interaction.message.id);

  const clicker = interaction.user;
  const label = clicker.displayName || clicker.username;
  const answerText = chosen.length === 1 ? `I chose: ${chosen[0]}` : `I chose: ${chosen.join(", ")}`;
  const repliedTo = [
    "--- Question answered ---",
    `[${state.title || "Question"}]: ${chosen.map((c) => `"${c}"`).join(", ")} (answered by ${label})`,
    "--- End ---",
  ].join("\n");

  await enqueueChat(interaction.message, answerText, [], {
    userId: state.fromUserId,
    displayName: label,
    speakerUsername: clicker.username,
    repliedTo,
    forceQueue: true,
  });
}

async function handleQuestionAnswerModal(interaction) {
  const msgId = interaction.customId.split(":")[1];
  const state = questionState.get(msgId);
  if (!state || !state.input || !state.input.length) {
    await interaction.reply({ content: "This question has no input field.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  if (interaction.user.bot) return;
  const fields = state.input.slice(0, 5);
  const modal = new ModalBuilder()
    .setCustomId(`qmodal:${msgId}`)
    .setTitle((state.title || "Your answer").slice(0, 45));
  for (let i = 0; i < fields.length; i++) {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(`qfield:${i}`)
          .setLabel(fields[i].slice(0, 45) || `Field ${i + 1}`)
          .setStyle(TextInputStyle.Short)
          .setRequired(true),
      ),
    );
  }
  await interaction.showModal(modal).catch(() => {});
}

async function handleQuestionModalSubmit(interaction) {
  const msgId = interaction.customId.split(":")[1];
  const state = questionState.get(msgId);
  if (!state) {
    await interaction.reply({ content: "That question is no longer active.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  if (interaction.user.bot) return;
  const fields = (state.input || []).slice(0, 5);
  const answers = [];
  for (let i = 0; i < fields.length; i++) {
    const v = interaction.fields.getTextInputValue(`qfield:${i}`).trim();
    if (v) answers.push({ field: fields[i], value: v });
  }
  if (answers.length === 0) {
    await interaction.reply({ content: "No answer provided.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }

  // Remove components so the question can't be answered twice.
  await interaction.update({ components: [] }).catch(() => {});
  questionState.delete(msgId);

  const clicker = interaction.user;
  const label = clicker.displayName || clicker.username;
  const answerText = answers.map((a) => `${a.field}: ${a.value}`).join("\n");
  const repliedTo = [
    "--- Question answered ---",
    `[${state.title || "Question"}] (answered by ${label}):`,
    ...answers.map((a) => `${a.field}: "${a.value}"`),
    "--- End ---",
  ].join("\n");

  await enqueueChat(interaction.message, answerText, [], {
    userId: state.fromUserId,
    displayName: label,
    speakerUsername: clicker.username,
    repliedTo,
    forceQueue: true,
  });
}

async function handleQuestionCheckboxOpen(interaction) {
  const msgId = interaction.customId.split(":")[1];
  const state = questionState.get(msgId);
  if (!state) {
    await interaction.reply({ content: "That question is no longer active.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  if (interaction.user.bot) return;
  const opts = state.options.slice(0, 10);
  if (opts.length === 0) {
    await interaction.reply({ content: "This question has no options.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  const group = new CheckboxGroupBuilder()
    .setCustomId(`qchkgroup:${msgId}`)
    .setMinValues(0)
    .setMaxValues(opts.length)
    .setRequired(false)
    .addOptions(opts.map((o, i) => ({ value: `o${i}`, label: o.slice(0, 100) })));
  const label = new LabelBuilder()
    .setLabel((state.title || "Select all that apply").slice(0, 45))
    .setCheckboxGroupComponent(group);
  if (state.description) label.setDescription(state.description.slice(0, 100));
  const modal = new ModalBuilder()
    .setCustomId(`qchksubmit:${msgId}`)
    .setTitle((state.title || "Choices").slice(0, 45))
    .addComponents(label);
  await interaction.showModal(modal).catch(() => {});
}

async function handleQuestionCheckboxSubmit(interaction) {
  const msgId = interaction.customId.split(":")[1];
  const state = questionState.get(msgId);
  if (!state) {
    await interaction.reply({ content: "That question is no longer active.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  if (interaction.user.bot) return;
  const field = interaction.fields.getField(`qchkgroup:${msgId}`);
  const chosen = [];
  for (const v of field?.values || []) {
    const idx = Number(String(v).replace(/^o/, ""));
    if (!Number.isNaN(idx) && state.options[idx] != null) chosen.push(state.options[idx]);
  }
  if (chosen.length === 0) {
    await interaction.reply({ content: "No options selected.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }

  await interaction.update({ components: [] }).catch(() => {});
  questionState.delete(msgId);

  const clicker = interaction.user;
  const label = clicker.displayName || clicker.username;
  const answered = [
    "--- Question answered ---",
    `[${state.title || "Question"}]: ${chosen.map((c) => `"${c}"`).join(", ")} (answered by ${label})`,
    "--- End ---",
  ].join("\n");

  await enqueueChat(interaction.message, `I chose: ${chosen.join(", ")}`, [], {
    userId: state.fromUserId,
    displayName: label,
    speakerUsername: clicker.username,
    repliedTo: answered,
    forceQueue: true,
  });
}

async function fireRoutine(routine) {
  // Heartbeat routines DM the user directly — no channel needed
  if (routine.type === "heartbeat") {
    const uid = routine.userId;
    console.log(`[heartbeat] firing routine ${routine.id} uid=${uid}`);
    const start = Date.now();

    const sandboxUrl = await ensureUserSandbox(uid);
    if (!sandboxUrl) {
      try {
        const dm = await client.users.createDM(uid);
        await dm.send("⚠️ Heartbeat failed — sandbox unreachable.");
      } catch {}
      state.recordActivity({
        userId: uid, type: "heartbeat", prompt: routine.payload.slice(0, 500),
        response: "sandbox unreachable", status: "error", duration: Date.now() - start,
        routineId: routine.id,
      });
      return;
    }

    const existingSession = state.getHeartbeatSession(uid);
    const prompt = `[user:${uid}] (heartbeat): ${routine.payload}`;

    try {
      const res = await withUserRunLock(uid, () =>
        runAgent(prompt, existingSession, null, null, uid),
      );
      state.setHeartbeatSession(uid, res.sessionId);

      const { clean: textAfterMemory, saved, dropped } = persistMemoryTags(res.text, uid, null);
      const { clean: textAfterAttachments, attachments } = extractAttachments(textAfterMemory);

      const filesToSend = [];
      for (const relPath of attachments) {
        try {
          const f = await getFile(relPath, uid);
          pushFile(filesToSend, f.buffer, f.name);
        } catch (err) {
          console.error(`[heartbeat] attachment fetch failed:`, err.message);
        }
      }

      let out = textAfterAttachments || "";
      const { clean: textAfterEmbeds, embeds, errors: embedErrors } = extractEmbeds(out);
      const { clean: textAfterQuestions, questions } = extractQuestions(textAfterEmbeds);
      out = textAfterQuestions || "";

      const notes = [];
      if (saved) notes.push(`remembered ${saved}`);
      if (dropped) notes.push(`forgot ${dropped}`);
      if (oversizeNote(filesToSend)) notes.push(oversizeNote(filesToSend));
      if (embedErrors.length) notes.push(embedErrors.join("; "));
      if (notes.length) out += (out ? "\n\n" : "") + `_🧠 ${notes.join(", ")}_`;

      const sendable = filesToSend.filter((f) => !f.oversize);
      if (!out && sendable.length === 0 && embeds.length === 0 && questions.length === 0) {
        out = "_(heartbeat completed, no output)_";
      }

      const header = `💓 **Heartbeat** —\n`;
      const dm = await client.users.createDM(uid);
      const parts = chunk(header + out);
      for (let i = 0; i < parts.length; i++) {
        const options = { content: parts[i], allowedMentions: { parse: [] } };
        if (i === 0) {
          if (sendable.length > 0) options.files = sendable;
          if (embeds.length > 0) options.embeds = embeds;
        }
        await dm.send(options);
      }
      for (const q of questions) {
        await sendQuestion(dm, q, uid);
      }

      state.recordActivity({
        userId: uid, type: "heartbeat", prompt: routine.payload.slice(0, 500),
        response: (out || "").slice(0, 2000), sessionId: res.sessionId, status: "success",
        duration: Date.now() - start, routineId: routine.id,
        ...statistics.tokenFieldsFromAgent(res),
      });
    } catch (err) {
      console.error(`[heartbeat] routine ${routine.id} failed:`, err.message);
      try {
        const dm = await client.users.createDM(uid);
        await dm.send(`⚠️ Heartbeat error: ${err.message}`);
      } catch {}
      state.recordActivity({
        userId: uid, type: "heartbeat", prompt: routine.payload.slice(0, 500),
        response: err.message.slice(0, 2000), sessionId: existingSession || null,
        status: "error", duration: Date.now() - start, routineId: routine.id,
      });
    }
    return;
  }

  // message / llm routines require a channel
  let ch;
  try {
    ch = await client.channels.fetch(routine.channelId);
  } catch {
    ch = null;
  }
  if (!ch?.isTextBased()) {
    // Channel deleted or inaccessible — try DM as fallback
    try {
      const dm = await client.users.createDM(routine.userId);
      await dm.send({
        content: `⏰ **Reminder** — (channel <#${routine.channelId}> unavailable)\n${routine.payload}`,
        allowedMentions: { users: [routine.userId] },
      });
      console.log(`[routines] routine ${routine.id} sent via DM fallback (channel unavailable)`);
      return;
    } catch (dmErr) {
      throw new Error(`Channel ${routine.channelId} not found and DM fallback failed: ${dmErr.message}`);
    }
  }

  if (routine.type === "message") {
    console.log(`[routines] firing message routine ${routine.id} uid=${routine.userId} cid=${routine.channelId}`);
    await ch.send({
      content: `⏰ **Reminder** — <@${routine.userId}>\n${routine.payload}`,
      allowedMentions: { users: [routine.userId] },
    });
    state.recordActivity({
      userId: routine.userId, channelId: routine.channelId, type: "reactive",
      prompt: routine.payload.slice(0, 500), status: "success", duration: 0,
      routineId: routine.id,
    });
    return;
  }

  const sandboxUrl = await ensureUserSandbox(routine.userId);
  if (!sandboxUrl) {
    await ch.send({
      content: `⚠️ <@${routine.userId}> Scheduled automation failed — sandbox unreachable.`,
      allowedMentions: { users: [routine.userId] },
    });
    return;
  }

  const uid = routine.userId;
  const cid = routine.channelId;
  const prompt = `[user:${uid}] (scheduled routine): ${routine.payload}`;
  const start = Date.now();

  console.log(`[routines] firing llm routine ${routine.id} uid=${uid} cid=${cid}`);
  const sessionId = routine.isolatedSession ? null : store.getSession(cid);
  const res = await withUserRunLock(uid, () =>
    runAgent(prompt, sessionId, null, null, uid),
  );
  if (!routine.isolatedSession) store.setSession(cid, res.sessionId);

  const filesToSend = [];

  const { clean: textAfterMemory, saved, dropped } = persistMemoryTags(res.text, uid, cid);
  const { clean: textAfterAttachments, attachments } = extractAttachments(textAfterMemory);

  for (const relPath of attachments) {
    try {
      const f = await getFile(relPath, uid);
      pushFile(filesToSend, f.buffer, f.name);
    } catch (err) {
      console.error(`[routines] attachment fetch "${relPath}" failed:`, err.message);
    }
  }

  let out = textAfterAttachments || "";
  const { clean: textAfterEmbeds, embeds, errors: embedErrors } = extractEmbeds(out);
  const { clean: textAfterQuestions, questions } = extractQuestions(textAfterEmbeds);
  out = textAfterQuestions || "";

  const notes = [];
  if (saved) notes.push(`remembered ${saved}`);
  if (dropped) notes.push(`forgot ${dropped}`);
  if (oversizeNote(filesToSend)) notes.push(oversizeNote(filesToSend));
  if (embedErrors.length) notes.push(embedErrors.join("; "));
  if (notes.length) out += (out ? "\n\n" : "") + `_🧠 ${notes.join(", ")}_`;

  // Attribution label at the very bottom. NOTE: routines send via chunk()
  // directly, NOT through handleChat — keep it that way or labels double up.
  const label = labelLineFor(uid);
  if (label) out += label;

  const sendable = filesToSend.filter((f) => !f.oversize);
  if (!out && sendable.length === 0 && embeds.length === 0 && questions.length === 0) {
    out = "_(routine completed, no output)_";
  }

  const header = `🤖 **Scheduled automation** — <@${routine.userId}>\n`;
  const parts = chunk(header + out);
  for (let i = 0; i < parts.length; i++) {
    const options = {
      content: parts[i],
      allowedMentions: { parse: [], users: [routine.userId] },
    };
    if (i === 0) {
      if (sendable.length > 0) options.files = sendable;
      if (embeds.length > 0) options.embeds = embeds;
    }
    await ch.send(options);
  }
  for (const q of questions) {
    await sendQuestion(ch, q, uid);
  }
  state.recordActivity({
    userId: uid, channelId: cid, type: "reactive",
    prompt: routine.payload.slice(0, 500),
    response: (out || "").slice(0, 2000), sessionId: res.sessionId, status: "success",
    duration: Date.now() - start, routineId: routine.id,
    ...statistics.tokenFieldsFromAgent(res),
  });
}

function verifyRoutineUser(bodyUserId, headerUserId) {
  if (headerUserId && bodyUserId && headerUserId !== bodyUserId) {
    throw new Error("userId does not match x-discord-user-id header");
  }
  return headerUserId || bodyUserId;
}

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
    const replyToBot = voiceMemo ? await isReplyToBot(message) : false;
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

async function resolveSttConfigForUser(userId) {
  let sandboxEnv = {};
  try {
    if (apiUrlFor(userId)) {
      const data = await getEnv(userId);
      sandboxEnv = data?.env && typeof data.env === "object" ? data.env : {};
    }
  } catch (err) {
    console.error("[stt] failed to load sandbox env for keys:", err.message);
  }
  return resolveSttConfig({ env: process.env, sandboxEnv });
}

async function isReplyToBot(message) {
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
      if (allowedChannel && targetMessage.channelId !== allowedChannel) return;
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

    await enqueueChat(
      targetMessage,
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

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton() && interaction.customId.startsWith("stats:")) {
    await statistics.handleStatisticsInteraction(interaction, statisticsExtrasForUser);
    return;
  }

  if (interaction.isButton() && (interaction.customId.startsWith("docfix:") || interaction.customId.startsWith("docconfirm:"))) {
    const [kind, token] = interaction.customId.split(":");
    const repair = doctorRepairTokens.get(token);
    if (!repair || repair.expiresAt < Date.now()) {
      doctorRepairTokens.delete(token);
      await interaction.reply({ content: "This doctor repair expired. Run `/doctor` again.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.user.id !== repair.requesterId) {
      await interaction.reply({ content: "Only the user who ran `/doctor` can apply this repair.", flags: MessageFlags.Ephemeral });
      return;
    }
    const mapping = sandbox.loadUsers().find((entry) => entry.name === repair.sandboxName);
    if (!mapping) {
      doctorRepairTokens.delete(token);
      await interaction.reply({ content: "Sandbox mapping no longer exists.", flags: MessageFlags.Ephemeral });
      return;
    }
    const stillOwnsSandbox = mapping.userId === interaction.user.id;
    const canManageServer = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) || interaction.guild?.ownerId === interaction.user.id;
    if (!stillOwnsSandbox && !canManageServer) {
      doctorRepairTokens.delete(token);
      await interaction.reply({ content: "You no longer have permission to repair this sandbox.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (repair.action === "reset-browser" && kind !== "docconfirm") {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`docconfirm:${token}`)
          .setLabel("Delete browser profile and saved logins")
          .setStyle(ButtonStyle.Danger),
      );
      await interaction.reply({
        content: "**Warning:** Resetting the browser profile permanently removes saved browser sessions, cookies, and logins.",
        components: [row],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    doctorRepairTokens.delete(token);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      let message;
      if (repair.action === "restart-container") {
        const restarted = await sandbox.restartContainer(repair.sandboxName);
        if (!restarted.ok) throw new Error(restarted.error);
        message = `Sandbox **${repair.sandboxName}** restarted.`;
      } else {
        const apiUrl = apiUrlFor(mapping.userId);
        if (!apiUrl) throw new Error("Sandbox supervisor URL is unavailable");
        const auth = "Basic " + Buffer.from("opencode:" + (process.env.OPENCODE_SERVER_PASSWORD || "")).toString("base64");
        const response = await fetch(`${apiUrl}/doctor/fix`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: auth,
            "x-punch-doctor-token": sandbox.doctorTokenFor(mapping.name),
          },
          body: JSON.stringify({ action: repair.action }),
          signal: AbortSignal.timeout(30_000),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !body.success) throw new Error(body.error || body.message || `supervisor API ${response.status}`);
        message = body.message;
      }
      await interaction.editReply(`✅ ${message} Run \`/doctor\` again after services settle.`);
    } catch (error) {
      await interaction.editReply(`⚠️ Repair failed: ${error.message}`);
    }
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith("qbtn:")) {
    await handleQuestionInteraction(interaction);
    return;
  }
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("qsel:")) {
    await handleQuestionInteraction(interaction);
    return;
  }
  if (interaction.isButton() && interaction.customId.startsWith("qans:")) {
    await handleQuestionAnswerModal(interaction);
    return;
  }
  if (interaction.isButton() && interaction.customId.startsWith("qchk:")) {
    await handleQuestionCheckboxOpen(interaction);
    return;
  }
  if (interaction.isModalSubmit() && interaction.customId.startsWith("qchksubmit:")) {
    await handleQuestionCheckboxSubmit(interaction);
    return;
  }
  if (interaction.isModalSubmit() && interaction.customId.startsWith("qmodal:")) {
    await handleQuestionModalSubmit(interaction);
    return;
  }
  if (interaction.isStringSelectMenu() && interaction.customId === "kill_select") {
    const pid = parseInt(interaction.values[0]);
    const uid = interaction.user.id;

    try {
      await killBackgroundTask(pid, uid);
      await interaction.reply({ content: `🛑 Killed process \`${pid}\`.`, flags: MessageFlags.Ephemeral });

      const res = await listBackgroundTasks(uid);
      const tasks = res.tasks || [];

      if (tasks.length === 0) {
        await interaction.message.edit({
          content: "No active background tasks running in the sandbox.",
          embeds: interaction.message.embeds,
          components: []
        });
      } else {
        const embed = new EmbedBuilder()
          .setTitle("🏃 Active Background Tasks")
          .setDescription(tasks.map(t => {
            const shortCmd = t.cmd.length > 60 ? t.cmd.slice(0, 57) + "..." : t.cmd;
            return `\`\`${t.pid}\`\` | ${t.stat} | ${t.start} | \`${shortCmd}\``;
          }).join("\n"))
          .setColor(0x00ff99);

        const selectOptions = tasks.slice(0, 25).map(t => ({
          label: `PID ${t.pid}`,
          description: `${t.stat} | ${t.cmd.slice(0, 100)}`,
          value: String(t.pid),
        }));

        const row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("kill_select")
            .setPlaceholder("Select a process to kill...")
            .addOptions(selectOptions)
        );

        await interaction.message.edit({ embeds: [embed], components: [row] });
      }
    } catch (err) {
      await interaction.reply({ content: `⚠️ Error: ${err.message}`, flags: MessageFlags.Ephemeral });
    }
    return;
  }

  if (interaction.isButton()) {
    const [action, pendingId] = (interaction.customId || "").split(":");
    if (pendingId?.startsWith("pg_") && (action === "pigeon_allow" || action === "pigeon_deny" || action === "pigeon_trust" || action === "pigeon_deny_always")) {
      const pending = pigeonGate.getPending(pendingId);
      if (!pending) {
        await interaction.reply({ content: "This pigeon request expired.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (interaction.user.id !== pending.recipientId) {
        await interaction.reply({ content: "Only the recipient can respond to this.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (action === "pigeon_deny") {
        pigeonGate.deletePending(pendingId);
        await interaction.update({
          content: `❌ **Denied** agent pigeon from **${pending.from}**.`,
          components: [],
        });
        const senderUid = pigeonGate.userIdForSandboxName(pending.from);
        const recipientSandbox = sandboxNameForUser(pending.recipientId);
        if (senderUid && recipientSandbox) {
          await notifyPigeonDM(senderUid, recipientSandbox, `Your agent pigeon to **${recipientSandbox}** was **denied**.`);
        }
        return;
      }
      if (action === "pigeon_deny_always") {
        try {
          setPigeonDeny(pending.recipientId, "add", pending.from);
        } catch (err) {
          await interaction.reply({ content: `⚠️ ${err.message}`, flags: MessageFlags.Ephemeral });
          return;
        }
        pigeonGate.deletePending(pendingId);
        await interaction.update({
          content: `🚫 **Always denied** agent pigeons from **${pending.from}**.`,
          components: [],
        });
        const senderUid = pigeonGate.userIdForSandboxName(pending.from);
        const recipientSandbox = sandboxNameForUser(pending.recipientId);
        if (senderUid && recipientSandbox) {
          await notifyPigeonDM(senderUid, recipientSandbox, `Your agent pigeon to **${recipientSandbox}** was **denied** and your sandbox was added to their blocklist.`);
        }
        return;
      }
      if (action === "pigeon_trust") {
        try {
          setPigeonTrust(pending.recipientId, "add", pending.from);
        } catch (err) {
          await interaction.reply({ content: `⚠️ ${err.message}`, flags: MessageFlags.Ephemeral });
          return;
        }
      }
      pigeonGate.updatePending(pendingId, { status: "approved" });
      await interaction.update({
        content: `✅ **Approved** agent pigeon from **${pending.from}**.`,
        components: [],
      });
      await runApprovedAgentPigeon(pending, pendingId);
      return;
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "env") {
    const sub = interaction.options.getSubcommand();
    const uid = interaction.user.id;

    if (sub === "set") {
      const key = interaction.options.getString("key", true);
      const value = interaction.options.getString("value", true);
      try {
        await setEnv(key, value, uid);
        await interaction.reply({ content: `✅ Environment variable \`${key}\` set.`, flags: MessageFlags.Ephemeral });
      } catch (err) {
        await interaction.reply({ content: `⚠️ Error: ${err.message}`, flags: MessageFlags.Ephemeral });
      }
    } else if (sub === "list") {
      try {
        const { env } = await getEnv(uid);
        const keys = Object.keys(env || {});
        if (keys.length === 0) {
          await interaction.reply({ content: "No environment variables set.", flags: MessageFlags.Ephemeral });
        } else {
          await interaction.reply({ content: `**Environment variables:**\n${keys.map(k => `\`${k}\``).join(", ")}`, flags: MessageFlags.Ephemeral });
        }
      } catch (err) {
        await interaction.reply({ content: `⚠️ Error: ${err.message}`, flags: MessageFlags.Ephemeral });
      }
    } else if (sub === "delete") {
      const key = interaction.options.getString("key", true);
      try {
        await setEnv(key, "", uid);
        await interaction.reply({ content: `✅ Environment variable \`${key}\` deleted.`, flags: MessageFlags.Ephemeral });
      } catch (err) {
        await interaction.reply({ content: `⚠️ Error: ${err.message}`, flags: MessageFlags.Ephemeral });
      }
    }
  }

  if (interaction.commandName === "memory") {
    const sub = interaction.options.getSubcommand();
    const uid = interaction.user.id;
    const cid = interaction.channelId;
    const isDm = !interaction.guildId;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (sub === "export") {
      const bundle = store.exportUserMemory(uid, { source: "punch" });
      const content = JSON.stringify(bundle, null, 2) + "\n";
      await interaction.editReply({
        content: `Exported ${bundle.records.length} durable user memory record(s). Channel memories and DM daily notes are excluded.`,
        files: [{ attachment: Buffer.from(content, "utf8"), name: "punch-memory-export.json" }],
      });
      return;
    }

    if (sub === "import") {
      const attachment = interaction.options.getAttachment("file", true);
      if (attachment.size > 1_000_000) {
        await interaction.editReply("Import file is too large (maximum 1 MB).");
        return;
      }
      if (!attachment.name?.toLowerCase().endsWith(".json")) {
        await interaction.editReply("Import must be a `.json` file created by `/memory export`.");
        return;
      }
      try {
        const response = await fetch(attachment.url);
        if (!response.ok) throw new Error(`Discord attachment fetch failed (${response.status})`);
        const raw = await response.text();
        if (raw.length > 1_000_000) throw new Error("Import file is too large");
        const stats = store.importUserMemory(uid, JSON.parse(raw), { source: "punch-import" });
        await interaction.editReply(`Imported ${stats.imported} record(s); skipped ${stats.skipped} duplicate, invalid, or sensitive record(s). Removed ${stats.removed} duplicate(s) during compaction.`);
      } catch (error) {
        await interaction.editReply(`Import failed: ${error.message}`);
      }
      return;
    }

    if (sub === "compact") {
      const stats = store.compactMemory({ userId: uid, channelId: cid });
      await interaction.editReply(`Memory compacted: ${stats.before} → ${stats.after}; removed ${stats.removed} duplicate(s).`);
      return;
    }

    if (sub === "view") {
      try {
        const file = await getFile("/work/.punch-memory.md", uid);
        const text = file.buffer.toString("utf8").slice(0, 1900);
        await interaction.editReply({ content: `**Project memory:**\n\n${text}` });
      } catch (err) {
        await interaction.editReply({ content: `\u26a0\ufe0f Could not read memory: ${err.message}` });
      }
      return;
    }

    const query = interaction.options.getString("query", true);
    const results = sub === "explain"
      ? store.explainMemory({ userId: uid, channelId: cid, query, isDm, limit: 10 })
      : store.searchMemory({ userId: uid, channelId: cid, query, isDm, limit: 10 });
    if (!results.length) {
      await interaction.editReply("No relevant memories found.");
      return;
    }
    const lines = results.map((item, index) => {
      const text = String(item.text).replace(/[`\r\n]+/g, " ").slice(0, 220);
      const detail = sub === "explain" ? ` — ${item.reason}` : "";
      return `${index + 1}. \`${item.citation}\` ${text}${detail}`;
    });
    let content = `**Memory ${sub}:**\n${lines.join("\n")}`;
    if (content.length > 1_900) content = `${content.slice(0, 1_899)}…`;
    await interaction.editReply({ content, allowedMentions: { parse: [] } });
    return;
  }

  if (interaction.commandName === "doctor") {
    const requesterId = interaction.user.id;
    const requestedSandbox = interaction.options.getString("sandbox")?.toLowerCase() || null;
    const canManageServer = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) || interaction.guild?.ownerId === requesterId;
    if (requestedSandbox && !canManageServer) {
      await interaction.reply({ content: "Inspecting another sandbox requires Manage Server permission.", flags: MessageFlags.Ephemeral });
      return;
    }

    const users = sandbox.loadUsers();
    const mapping = requestedSandbox
      ? users.find((entry) => entry.name === requestedSandbox)
      : users.find((entry) => entry.userId === requesterId);
    if (!mapping) {
      await interaction.reply({ content: requestedSandbox ? `Sandbox **${requestedSandbox}** was not found.` : "No sandbox is mapped to your Discord account.", flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const apiUrl = apiUrlFor(mapping.userId);
    let gatewayUrl = null;
    if (apiUrl) {
      try {
        const parsed = new URL(apiUrl);
        parsed.port = "4096";
        gatewayUrl = parsed.toString().replace(/\/$/, "");
      } catch {
        gatewayUrl = apiUrl.replace(/:4097$/, ":4096");
      }
    }
    const diagnostics = await runDoctor({
      userId: mapping.userId,
      sandboxName: mapping.name,
      deep: interaction.options.getBoolean("deep") || false,
      sandbox,
      apiUrl,
      gatewayUrl,
      doctorToken: sandbox.doctorTokenFor(mapping.name),
      routines,
    });

    const actions = new Map();
    const failedIds = new Set(diagnostics.checks.filter((item) => item.status === "fail").map((item) => item.id));
    const warningIds = new Set(diagnostics.checks.filter((item) => item.status === "warn").map((item) => item.id));
    if (failedIds.has("container")) actions.set("restart-container", ["Restart sandbox", ButtonStyle.Primary]);
    if (["gateway", "pi-process", "pi-health", "browser-extension"].some((id) => failedIds.has(id))) actions.set("restart-gateway", ["Restart Pi gateway", ButtonStyle.Primary]);
    if (["storage-access", "storage-write-probe"].some((id) => failedIds.has(id))) actions.set("repair-storage", ["Repair directories", ButtonStyle.Secondary]);
    if (failedIds.has("browser-probe")) actions.set("reset-browser", ["Reset browser profile", ButtonStyle.Danger]);
    if (warningIds.has("secret-permissions")) actions.set("repair-permissions", ["Tighten secret files", ButtonStyle.Secondary]);
    const components = actions.size
      ? [new ActionRowBuilder().addComponents(...[...actions].slice(0, 5).map(([action, [label, style]]) => {
          const token = createDoctorRepairToken(action, mapping.name, requesterId);
          return new ButtonBuilder().setCustomId(`docfix:${token}`).setLabel(label).setStyle(style);
        }))]
      : [];
    await interaction.editReply({ content: renderDoctorReport(diagnostics, mapping.name), components });
    return;
  }

  if (interaction.commandName === "sandbox") {
    const sub = interaction.options.getSubcommand();

    if (sub === "list") {
      const users = sandbox.loadUsers();
      if (users.length === 0) {
        await interaction.reply({ content: "No dynamic sandbox users configured. Use `/sandbox create` to add one.", flags: MessageFlags.Ephemeral });
        return;
      }
      const lines = users.map((u, i) => `${i + 1}. **${u.name}** — \`${u.userId}\``);
      await interaction.reply({ content: `**Sandbox users:**\n${lines.join("\n")}`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (sub === "create") {
      const name = interaction.options.getString("name", true).toLowerCase().replace(/[^a-z0-9-]/g, "");
      const userId = interaction.options.getString("userid", true);

      if (!name) {
        await interaction.reply({ content: "Name must contain only lowercase letters, digits, and hyphens.", flags: MessageFlags.Ephemeral });
        return;
      }

      const add = sandbox.addUser(name, userId);
      if (!add.ok) {
        await interaction.reply({ content: `⚠️ ${add.error}`, flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.reply({ content: `Creating sandbox for **${name}** (\`${userId}\`)…`, flags: MessageFlags.Ephemeral });

      const up = await sandbox.composeUp(name);
      if (!up.ok) {
        sandbox.removeUser(name);
        const err = up.error.length > 1500 ? up.error.slice(0, 1500) + "..." : up.error;
        await interaction.editReply({ content: `⚠️ Failed to create sandbox: ${err}` });
        return;
      }

      reloadSandboxMap();
      const vp = sandbox.vncPorts(name);
      const vncNote = process.env.VNC_PASSWORD
        ? `\n🌐 VNC: http://<host>:${vp.web}/ (password-protected) or raw VNC on port ${vp.vnc}.`
        : "";
      await interaction.editReply({ content: `✅ Sandbox **${name}** created and running!${vncNote}` });
      return;
    }

    if (sub === "remove") {
      const name = interaction.options.getString("name", true).toLowerCase();

      const down = await sandbox.composeDown(name);
      if (!down.ok) {
        await interaction.reply({ content: `⚠️ Failed to remove sandbox container: ${down.error}`, flags: MessageFlags.Ephemeral });
        return;
      }

      const del = sandbox.removeUser(name);
      if (!del.ok) {
        await interaction.reply({ content: `⚠️ ${del.error}`, flags: MessageFlags.Ephemeral });
        return;
      }

      reloadSandboxMap();
      await interaction.reply({ content: `✅ Sandbox **${name}** removed.`, flags: MessageFlags.Ephemeral });
      return;
    }
  }

  if (interaction.commandName === "collab") {
    const sub = interaction.options.getSubcommand();
    const owner = sandboxNameForUser(interaction.user.id);
    if (!owner) {
      await interaction.reply({ content: "No sandbox assigned.", flags: MessageFlags.Ephemeral });
      return;
    }
    try {
      if (sub === "status") {
        const records = collabs.listFor(owner);
        const text = records.length
          ? records.map((record) => {
              const proposal = record.proposal;
              return `**${record.id}** with **${record.participants.find((name) => name !== owner)}**\nmain: \`${record.base.slice(0, 12)}\`${proposal ? ` · ${proposal.status} · ${proposal.head.slice(0, 12)}` : " · no proposal"}`;
            }).join("\n")
          : "No collaborations.";
        await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
        return;
      }
      const reviewer = interaction.options.getString("reviewer", true).toLowerCase();
      const workspace = interaction.options.getString("workspace", true);
      const task = sub === "start" ? interaction.options.getString("task", true) : "";
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const collab = await collabs.create({ owner, reviewer, workspace });
      if (task) {
        const reviewerId = sandbox.loadUsers().find((user) => user.name === reviewer)?.userId;
        if (reviewerId) {
          handleAgentPigeon(reviewerId, owner, `Collaboration ${collab.id} started. Your clone is ${collab.workspaces[reviewer]}. ${task}`, 0).catch(() => {});
        }
      }
      await interaction.editReply({ content: `Collaboration **${collab.id}** ready. **${reviewer}** cloned at \`${collab.workspaces[reviewer]}\`. Both agents must use the \`collab\` tool; matching approvals auto-merge into \`main\`.` });
    } catch (error) {
      await interaction.reply({ content: `⚠️ ${error.message}`, flags: MessageFlags.Ephemeral }).catch(async () => interaction.editReply({ content: `⚠️ ${error.message}` }));
    }
    return;
  }

  if (interaction.commandName === "skills") {
    const sub = interaction.options.getSubcommand();
    const uid = interaction.user.id;
    const url = apiUrlFor(uid);
    const auth = "Basic " + Buffer.from("opencode:" + (process.env.OPENCODE_SERVER_PASSWORD || "")).toString("base64");
    if (!url) {
      await interaction.reply({ content: "No sandbox assigned.", flags: MessageFlags.Ephemeral });
      return;
    }
    try {
      if (sub === "list" || sub === "proposals") {
        const endpoint = sub === "list" ? "/skills" : "/skills/proposals";
        const res = await fetch(`${url}${endpoint}`, { headers: { authorization: auth } });
        if (!res.ok) throw new Error(`supervisor API ${res.status}`);
        const data = await res.json();
        const entries = sub === "list" ? data.skills : data.proposals;
        const body = !entries?.length ? (sub === "list" ? "No instruction skills installed." : "No skill proposals pending review.") : sub === "list"
          ? `**Instruction skills** (enabled skills auto-apply every Discord turn — no \`/skill-name\` or \`pi --skill\` needed):\n${entries.map((skill) => `${skill.enabled ? "✅" : "⏸️"} **${skill.name}** (${skill.source})${skill.description ? ` — ${skill.description}` : ""}${skill.requirements?.missingEnv?.length || skill.requirements?.missingBinaries?.length ? ` [missing: ${[...(skill.requirements?.missingEnv || []), ...(skill.requirements?.missingBinaries || [])].join(", ")}]` : ""}`).join("\n")}`
          : `**Pending skill proposals:**\n${entries.map((proposal) => `\`${proposal.id}\` **${proposal.name}** (${proposal.size}B)`).join("\n")}`;
        await interaction.reply({ content: body.slice(0, 1_900), flags: MessageFlags.Ephemeral });
        return;
      }
      if (sub === "approve" || sub === "reject") {
        const id = interaction.options.getString("id", true);
        const res = await fetch(`${url}/skills/proposals/${encodeURIComponent(id)}`, { method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: JSON.stringify({ approve: sub === "approve" }) });
        if (!res.ok) throw new Error(`supervisor API ${res.status}`);
        const { result } = await res.json();
        await interaction.reply({ content: result.approved ? `Installed instruction skill \`${result.name}\`. It is enabled and applies on the next Discord turn — no Pi restart or slash invoke needed.` : `Rejected skill proposal \`${result.name}\`.`, flags: MessageFlags.Ephemeral });
        return;
      }
      const name = interaction.options.getString("name", true);
      if (sub === "inspect") {
        const res = await fetch(`${url}/skills/${encodeURIComponent(name)}`, { headers: { authorization: auth } });
        if (!res.ok) throw new Error(`supervisor API ${res.status}`);
        const { skill } = await res.json();
        await interaction.reply({ content: `**${skill.name}** (${skill.source}, ${skill.enabled ? "enabled" : "disabled"})\nIn Discord, enabled skills are injected every turn — ignore any \`/${skill.name}\` or \`pi --${skill.name}\` notes inside the skill.\n\`\`\`\n${skill.content.slice(0, 1_500)}\n\`\`\``, flags: MessageFlags.Ephemeral });
        return;
      }
      const res = await fetch(`${url}/skills/${encodeURIComponent(name)}`, { method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: JSON.stringify({ enabled: sub === "enable" }) });
      if (!res.ok) throw new Error(`supervisor API ${res.status}`);
      await interaction.reply({
        content: sub === "enable"
          ? `Enabled skill \`${name}\`. It now applies automatically on every Discord turn — you do **not** need \`/${name}\`, \`pi --${name}\`, or a Pi restart.`
          : `Disabled skill \`${name}\`. It will stop applying on the next turn.`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      await interaction.reply({ content: `⚠️ ${error.message}`, flags: MessageFlags.Ephemeral });
    }
    return;
  }

  if (interaction.commandName === "extensions") {
    const sub = interaction.options.getSubcommand();
    const uid = interaction.user.id;
    const url = apiUrlFor(uid);
    const auth = "Basic " + Buffer.from("opencode:" + (process.env.OPENCODE_SERVER_PASSWORD || "")).toString("base64");
    if (!url) {
      await interaction.reply({ content: "No sandbox assigned.", flags: MessageFlags.Ephemeral });
      return;
    }
    try {
      if (sub === "list") {
        const res = await fetch(`${url}/extensions`, { headers: { authorization: auth } });
        if (!res.ok) throw new Error(`supervisor API ${res.status}`);
        const { extensions } = await res.json();
        if (!extensions?.length) {
          await interaction.reply({ content: "No extensions found.", flags: MessageFlags.Ephemeral });
          return;
        }
        const body = `**Pi extensions:**\n${extensions.map((ext) => {
          const icon = ext.quarantined ? "🔴" : ext.disabled ? "⏸️" : "✅";
          const size = ext.size > 1024 ? `${(ext.size / 1024).toFixed(1)}KB` : `${ext.size}B`;
          return `${icon} **${ext.name}** (${size})`;
        }).join("\n")}`;
        await interaction.reply({ content: body.slice(0, 1_900), flags: MessageFlags.Ephemeral });
        return;
      }
      const name = interaction.options.getString("name", true);
      if (sub === "disable") {
        const res = await fetch(`${url}/extensions/disable`, { method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: JSON.stringify({ name }) });
        if (!res.ok) throw new Error(`supervisor API ${res.status}`);
        await interaction.reply({ content: `Disabled extension \`${name}\`. Pi will restart without it.`, flags: MessageFlags.Ephemeral });
        return;
      }
      if (sub === "enable") {
        const res = await fetch(`${url}/extensions/enable`, { method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: JSON.stringify({ name }) });
        if (!res.ok) throw new Error(`supervisor API ${res.status}`);
        await interaction.reply({ content: `Enabled extension \`${name}\`. Pi will restart with it.`, flags: MessageFlags.Ephemeral });
        return;
      }
    } catch (error) {
      await interaction.reply({ content: `⚠️ ${error.message}`, flags: MessageFlags.Ephemeral });
    }
    return;
  }

  if (interaction.commandName === "multitask") {
    const uid = interaction.user.id;
    const sub = interaction.options.getSubcommand();
    if (sub === "on") {
      await interaction.reply({
        content: settings.setMultitaskEnabled(uid, true),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (sub === "off") {
      await interaction.reply({
        content: settings.setMultitaskEnabled(uid, false),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (sub === "status") {
      const enabled = store.getUserSettings(uid).multitaskEnabled;
      const body = await activeStatusText(uid);
      await interaction.reply({
        content: `Multitask: **${enabled ? "on" : "off"}**\n${body}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (sub === "start") {
      const prompt = interaction.options.getString("prompt", true);
      const kind = interaction.options.getString("kind") || "coding";
      const model = interaction.options.getString("model") || undefined;
      const timeoutMinutes = Math.max(1, Math.min(30, interaction.options.getInteger("timeout_minutes") || 10));
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await startMultitaskWorker(uid, {
        channelId: interaction.channelId,
        messageId: null,
        text: prompt,
        contextMessages: [],
        opts: { workerKind: kind, model, timeoutMinutes },
      });
      if (result.ok) {
        await interaction.editReply({
          content: `Started subtask \`${result.worker.id.slice(0, 8)}\` (${result.worker.kind}) — watch this channel for the result.`,
        });
        await interaction.channel.send({
          content: `🧵 Started subtask \`${result.worker.id.slice(0, 8)}\` (${result.worker.kind}) — I'll reply here when done.`,
          allowedMentions: { parse: [] },
        });
      } else {
        await interaction.editReply({
          content: `⚠️ Could not start subtask: ${result.error || "unknown error"}`,
        });
      }
      return;
    }
  }

  if (interaction.commandName === "workers") {
    const uid = interaction.user.id;
    const url = apiUrlFor(uid);
    const auth = "Basic " + Buffer.from("opencode:" + (process.env.OPENCODE_SERVER_PASSWORD || "")).toString("base64");
    if (!url) { await interaction.reply({ content: "No sandbox assigned.", flags: MessageFlags.Ephemeral }); return; }
    const sub = interaction.options.getSubcommand();
    try {
      await syncMultitaskWorkerCap(uid);
      if (sub === "list") {
        const res = await fetch(`${url}/workers`, { headers: { authorization: auth } });
        if (!res.ok) throw new Error(`supervisor API ${res.status}`);
        const { workers } = await res.json();
        const settings = await getMultitaskWorkerSettings(uid);
        const header = settings ? `**Workers** (${settings.active}/${settings.cap} active):\n` : "**Workers:**\n";
        const body = workers?.length ? `${header}${workers.slice(0, 15).map((worker) => `\`${worker.id.slice(0, 8)}\` ${worker.kind} **${worker.status}** — ${new Date(worker.createdAt).toLocaleString()}`).join("\n")}` : `${header.trim()} No workers.`;
        await interaction.reply({ content: body, flags: MessageFlags.Ephemeral });
        return;
      }
      const id = interaction.options.getString("id", sub !== "start");
      if (sub === "logs") {
        const res = await fetch(`${url}/workers/${encodeURIComponent(id)}/logs`, { headers: { authorization: auth } });
        if (!res.ok) throw new Error(`supervisor API ${res.status}`);
        const { record, log } = await res.json();
        await interaction.reply({ content: `**${record.kind}** \`${record.id}\` (${record.status})\n\`\`\`\n${(log || "(no log yet)").slice(-1_650)}\n\`\`\``, flags: MessageFlags.Ephemeral });
        return;
      }
      if (sub === "stop") {
        const res = await fetch(`${url}/workers/${encodeURIComponent(id)}/stop`, { method: "POST", headers: { authorization: auth } });
        if (!res.ok) throw new Error(`supervisor API ${res.status}`);
        await interaction.reply({ content: `Stopping worker \`${id}\`.`, flags: MessageFlags.Ephemeral });
        return;
      }
      const timeoutMinutes = Math.max(1, Math.min(30, interaction.options.getInteger("timeout_minutes") || 10));
      const res = await fetch(`${url}/workers`, { method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: JSON.stringify({ kind: interaction.options.getString("kind", true), prompt: interaction.options.getString("prompt", true), model: interaction.options.getString("model") || undefined, timeoutMs: timeoutMinutes * 60_000 }) });
      if (!res.ok) throw new Error(`supervisor API ${res.status}`);
      const { worker } = await res.json();
      await interaction.reply({ content: `Started isolated ${worker.kind} worker \`${worker.id}\`. Result will arrive in DM.`, flags: MessageFlags.Ephemeral });
    } catch (error) { await interaction.reply({ content: `⚠️ ${error.message}`, flags: MessageFlags.Ephemeral }); }
    return;
  }

  if (interaction.commandName === "multitask" && interaction.options.getSubcommandGroup() === "settings") {
    const uid = interaction.user.id;
    if (!apiUrlFor(uid)) { await interaction.reply({ content: "No sandbox assigned.", flags: MessageFlags.Ephemeral }); return; }
    const sub = interaction.options.getSubcommand();
    try {
      if (sub === "view") {
        await syncMultitaskWorkerCap(uid);
        const settings = await getMultitaskWorkerSettings(uid);
        const stored = store.getUserSettings(uid).multitaskWorkersCap;
        if (!settings) {
          await interaction.reply({ content: `Stored multitask worker cap: **${stored}**. This sandbox does not support worker settings yet.`, flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.reply({
          content: `**Multitask workers:** ${settings.active}/${settings.cap} active (${settings.available} slots free). Stored cap: **${stored}**.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (sub === "cap-set") {
        const cap = interaction.options.getInteger("cap", true);
        store.patchUserSettings(uid, { multitaskWorkersCap: cap });
        const settings = await syncMultitaskWorkerCap(uid);
        await interaction.reply({
          content: `Multitask worker cap set to **${settings.cap}** (${settings.active} active, ${settings.available} slots free).`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    } catch (error) { await interaction.reply({ content: `⚠️ ${error.message}`, flags: MessageFlags.Ephemeral }); }
    return;
  }

  if (interaction.commandName === "models") {
    const uid = interaction.user.id;
    const apiUrl = apiUrlFor(uid);
    const auth = "Basic " + Buffer.from("opencode:" + (process.env.OPENCODE_SERVER_PASSWORD || "")).toString("base64");
    try {
      const res = await fetch(`${apiUrl}/model`, { headers: { authorization: auth } });
      if (!res.ok) throw new Error(`supervisor API ${res.status}`);
      const { model: current } = await res.json();
      const options = MODEL_LIST.map(m => ({
        label: m.label,
        value: m.value,
        description: m.value === current ? "Currently selected" : undefined,
      }));
      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("model_select")
          .setPlaceholder(`Current: ${current}`)
          .addOptions(options)
      );
      await interaction.reply({
        content: `**Select a model** (current: \`${current}\`)\nChoose a model from the list or pick "Custom model..." to type one.`,
        components: [row],
        flags: MessageFlags.Ephemeral,
      });
    } catch (err) {
      await interaction.reply({ content: `⚠️ Error fetching model: ${err.message}`, flags: MessageFlags.Ephemeral });
    }
    return;
  }

  if (interaction.commandName === "apikey") {
    const uid = interaction.user.id;
    const apiUrl = apiUrlFor(uid);
    const auth = "Basic " + Buffer.from("opencode:" + (process.env.OPENCODE_SERVER_PASSWORD || "")).toString("base64");
    const provider = interaction.options.getString("provider", true).toLowerCase();
    const key = interaction.options.getString("key");
    if (!PROVIDER_NAMES.includes(provider)) {
      const provRes = await fetch(`${apiUrl}/providers`, { headers: { authorization: auth } });
      if (provRes.ok) {
        const { providers = [] } = await provRes.json();
        if (!providers.includes(provider)) {
          await interaction.reply({ content: `⚠️ Unknown provider \`${provider}\`. Use \`/provider add\` to register custom providers, or choose: ${PROVIDER_NAMES.join(", ")}`, flags: MessageFlags.Ephemeral });
          return;
        }
      } else {
        await interaction.reply({ content: `⚠️ Unknown provider \`${provider}\`. Valid: ${PROVIDER_NAMES.join(", ")}`, flags: MessageFlags.Ephemeral });
        return;
      }
    }
    try {
      const res = await fetch(`${apiUrl}/apikey`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: auth },
        body: JSON.stringify({ provider, key: key || null }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `supervisor API ${res.status}`);
      }
      await interaction.reply({
        content: key ? `✅ API key set for **${provider}**. Restarting sandbox LLM process…` : `✅ API key removed for **${provider}**. Restarting sandbox LLM process…`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (err) {
      await interaction.reply({ content: `⚠️ Error: ${err.message}`, flags: MessageFlags.Ephemeral });
    }
    return;
  }

  if (interaction.commandName === "provider") {
    const uid = interaction.user.id;
    const apiUrl = apiUrlFor(uid);
    const auth = "Basic " + Buffer.from("opencode:" + (process.env.OPENCODE_SERVER_PASSWORD || "")).toString("base64");
    const sub = interaction.options.getSubcommand();

    if (sub === "add") {
      const name = interaction.options.getString("name", true).toLowerCase().replace(/[^a-z0-9_-]/g, "");
      const endpoint = interaction.options.getString("endpoint", true);
      const api = interaction.options.getString("api") || "openai-completions";
      try {
        const res = await fetch(`${apiUrl}/provider`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: auth },
          body: JSON.stringify({ name, endpoint, api }),
        });
        if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || `supervisor API ${res.status}`); }
        await interaction.reply({
          content: `\u2705 Custom provider **${name}** created.\nEndpoint: \`${endpoint}\`\n\nAdd models with: \`/provider model add ${name} <model-id>\``,
          flags: MessageFlags.Ephemeral,
        });
      } catch (err) { await interaction.reply({ content: `\u26a0\ufe0f Error: ${err.message}`, flags: MessageFlags.Ephemeral }); }
      return;
    }

    if (sub === "edit") {
      const name = interaction.options.getString("name", true).toLowerCase();
      const endpoint = interaction.options.getString("endpoint") || undefined;
      const api = interaction.options.getString("api") || undefined;
      if (!endpoint && !api) {
        await interaction.reply({ content: "\u26a0\ufe0f Provide at least one field to update (endpoint or api).", flags: MessageFlags.Ephemeral });
        return;
      }
      try {
        const res = await fetch(`${apiUrl}/provider`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: auth },
          body: JSON.stringify({ name, endpoint, api }),
        });
        if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || `supervisor API ${res.status}`); }
        await interaction.reply({ content: `\u2705 Provider **${name}** updated.`, flags: MessageFlags.Ephemeral });
      } catch (err) { await interaction.reply({ content: `\u26a0\ufe0f Error: ${err.message}`, flags: MessageFlags.Ephemeral }); }
      return;
    }

    if (sub === "remove") {
      const name = interaction.options.getString("name", true).toLowerCase();
      try {
        const res = await fetch(`${apiUrl}/provider`, {
          method: "DELETE",
          headers: { "content-type": "application/json", authorization: auth },
          body: JSON.stringify({ name }),
        });
        if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || `supervisor API ${res.status}`); }
        await interaction.reply({ content: `\u2705 Provider **${name}** removed.`, flags: MessageFlags.Ephemeral });
      } catch (err) { await interaction.reply({ content: `\u26a0\ufe0f Error: ${err.message}`, flags: MessageFlags.Ephemeral }); }
      return;
    }

    if (sub === "list") {
      try {
        const res = await fetch(`${apiUrl}/providers`, { headers: { authorization: auth } });
        if (!res.ok) throw new Error(`supervisor API ${res.status}`);
        const { providers = [], custom = {} } = await res.json();
        const lines = providers.map(p => {
          const cfg = custom[p];
          if (!cfg) return `\u2022 **${p}** (built-in)`;
          const modelCount = (cfg.models || []).length;
          return `\u2022 **${p}** \u2014 \`${cfg.baseUrl}\` (${modelCount} model${modelCount === 1 ? "" : "s"})`;
        });
        await interaction.reply({
          content: `**Available providers:**\n${lines.length ? lines.join("\n") : "No providers found."}`,
          flags: MessageFlags.Ephemeral,
        });
      } catch (err) { await interaction.reply({ content: `\u26a0\ufe0f Error: ${err.message}`, flags: MessageFlags.Ephemeral }); }
      return;
    }

    const group = interaction.options.getSubcommandGroup();
    if (group === "model") {
      if (sub === "add") {
        const provider = interaction.options.getString("provider", true).toLowerCase();
        const model = interaction.options.getString("model", true);
        const name = interaction.options.getString("name") || undefined;
        const context = interaction.options.getInteger("context") ?? undefined;
        const maxTokens = interaction.options.getInteger("max_tokens") ?? undefined;
        const reasoning = interaction.options.getBoolean("reasoning") ?? undefined;
        try {
          const res = await fetch(`${apiUrl}/provider/model`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: auth },
            body: JSON.stringify({ provider, model, name, context, maxTokens, reasoning }),
          });
          if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || `supervisor API ${res.status}`); }
          await interaction.reply({
            content: `\u2705 Model **${model}** added to **${provider}**.\nProperties: ${name ? `"${name}"` : model} | ${context ?? 128000} ctx | ${maxTokens ?? 4096} max${reasoning ? " | reasoning" : ""}`,
            flags: MessageFlags.Ephemeral,
          });
        } catch (err) { await interaction.reply({ content: `\u26a0\ufe0f Error: ${err.message}`, flags: MessageFlags.Ephemeral }); }
        return;
      }

      if (sub === "edit") {
        const provider = interaction.options.getString("provider", true).toLowerCase();
        const model = interaction.options.getString("model", true);
        try {
          const provRes = await fetch(`${apiUrl}/providers`, { headers: { authorization: auth } });
          const { custom = {} } = await provRes.json();
          const cfg = custom[provider];
          if (!cfg) { await interaction.reply({ content: `\u26a0\ufe0f Provider **${provider}** not found.`, flags: MessageFlags.Ephemeral }); return; }
          const modelEntry = (cfg.models || []).find(m => m.id === model);
          if (!modelEntry) { await interaction.reply({ content: `\u26a0\ufe0f Model **${model}** not found on **${provider}**.`, flags: MessageFlags.Ephemeral }); return; }

          const modal = new ModalBuilder()
            .setCustomId(`model_edit_modal:${provider}:${model}`)
            .setTitle(`Edit: ${provider}/${model}`);

          const nameInput = new TextInputBuilder()
            .setCustomId("edit_name")
            .setLabel("Display name")
            .setStyle(TextInputStyle.Short)
            .setValue(modelEntry.name || "")
            .setRequired(false)
            .setMaxLength(100);

          const ctxInput = new TextInputBuilder()
            .setCustomId("edit_context")
            .setLabel("Context window (number)")
            .setStyle(TextInputStyle.Short)
            .setValue(String(modelEntry.contextWindow ?? ""))
            .setRequired(false)
            .setMaxLength(10);

          const mtInput = new TextInputBuilder()
            .setCustomId("edit_maxTokens")
            .setLabel("Max tokens (number)")
            .setStyle(TextInputStyle.Short)
            .setValue(String(modelEntry.maxTokens ?? ""))
            .setRequired(false)
            .setMaxLength(10);

          const reasonInput = new TextInputBuilder()
            .setCustomId("edit_reasoning")
            .setLabel("Reasoning (yes/no)")
            .setStyle(TextInputStyle.Short)
            .setValue(modelEntry.reasoning ? "yes" : "no")
            .setRequired(false)
            .setMaxLength(3);

          await interaction.showModal(modal.addComponents(
            new ActionRowBuilder().addComponents(nameInput),
            new ActionRowBuilder().addComponents(ctxInput),
            new ActionRowBuilder().addComponents(mtInput),
            new ActionRowBuilder().addComponents(reasonInput),
          ));
        } catch (err) { await interaction.reply({ content: `\u26a0\ufe0f Error: ${err.message}`, flags: MessageFlags.Ephemeral }); }
        return;
      }

      if (sub === "remove") {
        const provider = interaction.options.getString("provider", true).toLowerCase();
        const model = interaction.options.getString("model", true);
        try {
          const res = await fetch(`${apiUrl}/provider/model`, {
            method: "DELETE",
            headers: { "content-type": "application/json", authorization: auth },
            body: JSON.stringify({ provider, model }),
          });
          if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || `supervisor API ${res.status}`); }
          await interaction.reply({ content: `\u2705 Model **${model}** removed from **${provider}**.`, flags: MessageFlags.Ephemeral });
        } catch (err) { await interaction.reply({ content: `\u26a0\ufe0f Error: ${err.message}`, flags: MessageFlags.Ephemeral }); }
        return;
      }

      if (sub === "list") {
        const provider = interaction.options.getString("provider", true).toLowerCase();
        try {
          const res = await fetch(`${apiUrl}/providers`, { headers: { authorization: auth } });
          const { custom = {} } = await res.json();
          const cfg = custom[provider];
          if (!cfg) { await interaction.reply({ content: `\u26a0\ufe0f Provider **${provider}** not found.`, flags: MessageFlags.Ephemeral }); return; }
          const models = cfg.models || [];
          if (!models.length) {
            await interaction.reply({ content: `No models for **${provider}**. Add one: \`/provider model add ${provider} <model-id>\``, flags: MessageFlags.Ephemeral });
            return;
          }
          const lines = models.map(m => {
            const parts = [`\u2022 \`${m.id}\``];
            if (m.name && m.name !== m.id) parts.push(`\u2014 ${m.name}`);
            parts.push(`(${m.contextWindow ?? "?"} ctx, ${m.maxTokens ?? "?"} max${m.reasoning ? ", reasoning" : ""})`);
            return parts.join(" ");
          });
          await interaction.reply({ content: `**Models for ${provider}:**\n${lines.join("\n")}`, flags: MessageFlags.Ephemeral });
        } catch (err) { await interaction.reply({ content: `\u26a0\ufe0f Error: ${err.message}`, flags: MessageFlags.Ephemeral }); }
        return;
      }
    }

    await interaction.reply({ content: "\u26a0\ufe0f Unknown subcommand.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.commandName === "settings") {
    try {
      await settings.handleSettingsSlash(interaction, settingsDeps());
    } catch (err) {
      const replied = interaction.replied || interaction.deferred;
      const payload = { content: `⚠️ ${err.message}` };
      if (replied) await interaction.followUp(payload);
      else await interaction.reply(payload);
    }
    return;
  }

  if (interaction.commandName === "trigger") {
    const sub = interaction.options.getSubcommand();
    const uid = interaction.user.id;
    try {
      if (sub === "set") {
        const word = interaction.options.getString("word", true).toLowerCase();
        await interaction.reply({ content: settings.setUserTriggerWord(uid, word) });
      } else {
        await interaction.reply({ content: settings.setUserTriggerWord(uid, null) });
      }
    } catch (err) {
      await interaction.reply({ content: `⚠️ ${err.message}` });
    }
    return;
  }

  if (interaction.commandName === "routine") {
    const sub = interaction.options.getSubcommand();
    const ctx = routineContextFromInteraction(interaction);

    if (sub === "add") {
      const type = interaction.options.getString("type", true);
      const when = interaction.options.getString("when", true);
      const text = interaction.options.getString("text", true);
      const recurrence = interaction.options.getString("recurrence") || "once";
      try {
        const userZone = userTimeZone(ctx.userId);
        const timezone = interaction.options.getString("timezone") || userZone;
        const activeStart = interaction.options.getInteger("active_start");
        const activeEnd = interaction.options.getInteger("active_end");
        const activeHours = activeStart === null || activeEnd === null ? null : { start: activeStart, end: activeEnd, timezone };
        const schedule = routines.parseRecurrence(when, recurrence, timezone);
        const routine = routines.addRoutine({
          ...ctx,
          channelId: type === "heartbeat" ? null : ctx.channelId,
          type, payload: text, schedule, timezone, activeHours,
          isolatedSession: interaction.options.getBoolean("isolated_session") || false,
        });
        const label = type === "heartbeat" ? "💓 Heartbeat" : "⏰ Scheduled";
        const note = type === "heartbeat" ? "\nI'll DM you the results each time." : "";
        const whenLabel = formatInTimeZone(routine.nextRunAt, routine.timezone || timezone) || new Date(routine.nextRunAt).toISOString();
        await interaction.reply({
          content: `${label} (\`${routine.id}\`) — fires ${whenLabel}${note}`,
          flags: MessageFlags.Ephemeral,
        });
      } catch (err) {
        await interaction.reply({ content: `⚠️ ${err.message}`, flags: MessageFlags.Ephemeral });
      }
      return;
    }

    if (sub === "history") {
      const id = interaction.options.getString("id") || null;
      const entries = routines.listHistory(ctx.userId, id, 20);
      const body = entries.length
        ? `**Routine history:**\n${entries.map((entry) => `${entry.status === "succeeded" ? "✅" : entry.status === "failed" ? "❌" : "⏳"} \`${entry.routineId}\` attempt ${entry.attempt} ${new Date(entry.startedAt).toLocaleString()}${entry.error ? ` — ${entry.error.slice(0, 180)}` : ""}`).join("\n")}`
        : "No routine history.";
      await interaction.reply({ content: body, flags: MessageFlags.Ephemeral });
      return;
    }

    if (sub === "remove") {
      const id = interaction.options.getString("id", true);
      const ok = routines.removeRoutine(id, ctx.userId);
      await interaction.reply({
        content: ok ? `Removed routine \`${id}\`.` : `No routine \`${id}\` found.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "pause" || sub === "resume") {
      const id = interaction.options.getString("id", true);
      const r = routines.setRoutineEnabled(id, ctx.userId, sub === "resume");
      await interaction.reply({
        content: r ? `${sub === "pause" ? "Paused" : "Resumed"} routine \`${id}\`.` : `No routine \`${id}\` found.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  if (interaction.commandName === "timeout") {
    const sub = interaction.options.getSubcommand();
    const uid = interaction.user.id;
    if (sub === "disable") {
      store.patchUserSettings(uid, { disableIdleTimeout: true });
      await interaction.reply({ content: "⏱️ Idle/stale timeouts disabled — hung turns won't be aborted for silence or heartbeat-only working (the hard ceiling still applies).", flags: MessageFlags.Ephemeral });
    } else if (sub === "enable") {
      store.patchUserSettings(uid, { disableIdleTimeout: false });
      await interaction.reply({ content: "⏱️ Idle/stale timeouts re-enabled (90s silence / ~3m stuck tool-or-working).", flags: MessageFlags.Ephemeral });
    } else {
      const us = store.getUserSettings(uid);
      await interaction.reply({ content: `⏱️ Idle/stale timeouts are currently **${us.disableIdleTimeout ? "disabled" : "enabled (90s silence / ~3m stuck working)"}**.`, flags: MessageFlags.Ephemeral });
    }
    return;
  }

  if (interaction.commandName === "botmode") {
    const sub = interaction.options.getSubcommand();
    const uid = interaction.user.id;

    if (sub === "auto-compress") {
      const threshold = interaction.options.getInteger("threshold");
      if (threshold != null) {
        try {
          validateAutoCompressThreshold(threshold);
        } catch (error) {
          await interaction.reply({ content: `\u26a0\ufe0f ${error.message}`, flags: MessageFlags.Ephemeral });
          return;
        }
        store.patchUserSettings(uid, { autoCompressThreshold: threshold });
        const msg = threshold === 0 ? "Automatic context-pruning prompt disabled." : `Context-pruning prompt threshold set to **${threshold}%**.`;
        await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
      } else {
        const us = store.getUserSettings(uid);
        const msg = us.autoCompressThreshold === 0 ? "Automatic context-pruning prompt **disabled**." : `Context-pruning prompt threshold: **${us.autoCompressThreshold}%**.`;
        await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
      }
      return;
    }

    const state = interaction.options.getString("state", true);
    const key = sub === "allow-bots" ? "allowBots" : sub === "show-context" ? "showContext" : sub === "git-co-author" ? "gitCoAuthor" : "noThinking";
    const label = sub === "allow-bots" ? "Bot messages triggering Punch" : sub === "show-context" ? "Always-on context indicator" : sub === "git-co-author" ? "Co-Authored-By trailer in commits" : "Thinking message";
    if (state === "status") {
      const us = store.getUserSettings(uid);
      await interaction.reply({ content: `${label} is currently **${us[key] ? "ON" : "off"}**.`, flags: MessageFlags.Ephemeral });
    } else {
      store.patchUserSettings(uid, { [key]: state === "on" });
      await interaction.reply({ content: `${label} **${state === "on" ? "enabled" : "disabled"}**.`, flags: MessageFlags.Ephemeral });
    }
    return;
  }

  if (interaction.commandName === "remind") {
    const when = interaction.options.getString("when", true);
    const message = interaction.options.getString("message", true);
    const ctx = routineContextFromInteraction(interaction);
    try {
      const zone = userTimeZone(ctx.userId);
      const routine = routines.addRoutine({
        ...ctx,
        type: "message",
        payload: message,
        timezone: zone,
        schedule: { kind: "once", at: routines.parseTime(when, new Date(), zone) },
      });
      const whenLabel = formatInTimeZone(routine.nextRunAt, zone) || new Date(routine.nextRunAt).toISOString();
      await interaction.reply({
        content: `⏰ Scheduled (\`${routine.id}\`) — fires ${whenLabel}`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (err) {
      await interaction.reply({ content: `⚠️ ${err.message}`, flags: MessageFlags.Ephemeral });
    }
    return;
  }

  if (interaction.commandName === "logs") {
    const sub = interaction.options.getSubcommand();
    const uid = interaction.user.id;

    if (!apiUrlFor(uid)) {
      await interaction.reply({ content: "No sandbox assigned.", flags: MessageFlags.Ephemeral });
      return;
    }

    if (sub === "status") {
      try {
        const body = logs.fetchLogStatus(uid);
        await interaction.reply({ content: body, flags: MessageFlags.Ephemeral });
      } catch (err) {
        await interaction.reply({ content: `⚠️ ${err.message}`, flags: MessageFlags.Ephemeral });
      }
      return;
    }

    const source = interaction.options.getString("source") || "all";
    const lines = Math.min(100, interaction.options.getInteger("lines") || 30);
    await interaction.reply({ content: "Fetching logs…", flags: MessageFlags.Ephemeral });
    try {
      await sendLogReply(interaction, uid, { source, lines });
    } catch (err) {
      await interaction.editReply({ content: `⚠️ ${err.message}` });
    }
    return;
  }

  if (interaction.commandName === "reset") {
    await withUserRunLock(interaction.user.id, () => store.clearSession(interaction.channelId));
    await interaction.reply({
      content: "Fresh session. Prior context dropped.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.commandName === "compress") {
    const uid = interaction.user.id;
    const cid = interaction.channelId;
    if (!store.getSession(cid)) {
      await interaction.reply({
        content: "Nothing to compress yet — there's no active conversation in this channel. Send a message first.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!apiUrlFor(uid)) {
      await interaction.reply({
        content: "You don't have a sandbox assigned, so there's no conversation to compress.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      content: `🔄 Compressing conversation…\n${progressBar(0)} 0%`,
      flags: MessageFlags.Ephemeral,
    });

    const start = Date.now();
    let progress = 0;
    const iv = setInterval(async () => {
      const elapsed = (Date.now() - start) / 1000;
      // Ease toward 95% while the server works; jumps to 100% on completion.
      // Slower ramp so the bar doesn't parking at the top for large sessions.
      const target = Math.min(95, (elapsed / 90) * 95);
      progress = Math.max(progress, target);
      const pct = Math.round(progress);
      await interaction.editReply(`🔄 Compressing conversation…\n${progressBar(pct)} ${pct}%`).catch(() => {});
    }, 1500);

    // Summarizing a long session can take well over the default per-turn HTTP
    // timeout (OPENCODE_TIMEOUT), so give it a dedicated, generous budget.
    const COMPRESS_TIMEOUT_MS = (Number(process.env.OPENCODE_COMPRESS_TIMEOUT) || 300) * 1000;
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), COMPRESS_TIMEOUT_MS);

    try {
      await withUserRunLock(uid, async () => {
        const currentSession = store.getSession(cid);
        if (!currentSession) throw new Error("Conversation reset before compression started.");
        await summarizeSession(currentSession, uid, ac.signal);
        store.clearMemoryRecall(currentSession);
      });
      clearInterval(iv);
      clearTimeout(to);
      await interaction.editReply(`✅ Conversation compressed.\n${progressBar(100)} 100%\nContext trimmed — fresh headspace for the next turn.`);
    } catch (err) {
      clearInterval(iv);
      clearTimeout(to);
      const msg = ac.signal.aborted
        ? `compression took longer than ${COMPRESS_TIMEOUT_MS / 1000}s — the session may be very large. Try again, or start fresh with a new session.`
        : err.message;
      await interaction.editReply(`⚠️ Compression failed: ${msg}`).catch(() => {});
    }
    return;
  }

  if (interaction.commandName === "heartbeat") {
    const sub = interaction.options.getSubcommand();
    const uid = interaction.user.id;
    const cid = interaction.channelId;

    if (sub === "add") {
      const when = interaction.options.getString("when", true);
      const prompt = interaction.options.getString("prompt", true);
      try {
        const zone = userTimeZone(uid);
        const schedule = routines.parseRecurrence(when, "once", zone);
        const routine = routines.addRoutine({
          userId: uid, channelId: null, guildId: interaction.guild?.id || null,
          type: "heartbeat", payload: prompt, schedule, timezone: zone,
        });
        const whenLabel = formatInTimeZone(routine.nextRunAt, zone) || new Date(routine.nextRunAt).toISOString();
        await interaction.reply({
          content: `💓 Heartbeat scheduled (\`${routine.id}\`) — fires ${whenLabel}\nI'll DM you the results each time.`,
          flags: MessageFlags.Ephemeral,
        });
      } catch (err) {
        await interaction.reply({ content: `⚠️ ${err.message}`, flags: MessageFlags.Ephemeral });
      }
      return;
    }

    if (sub === "list") {
      const list = routines.listRoutines(uid).filter((r) => r.type === "heartbeat");
      const body = list.length === 0
        ? "No heartbeat automations scheduled."
        : `**Your heartbeats (${list.length}):**\n${list.map(routines.formatRoutine).join("\n")}`;
      await interaction.reply({ content: body, flags: MessageFlags.Ephemeral });
      return;
    }

    if (sub === "remove") {
      const id = interaction.options.getString("id", true);
      const ok = routines.removeRoutine(id, uid);
      await interaction.reply({
        content: ok ? `Removed heartbeat \`${id}\`.` : `No heartbeat \`${id}\` found.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "pause" || sub === "resume") {
      const id = interaction.options.getString("id", true);
      const r = routines.setRoutineEnabled(id, uid, sub === "resume");
      await interaction.reply({
        content: r ? `${sub === "pause" ? "Paused" : "Resumed"} heartbeat \`${id}\`.` : `No heartbeat \`${id}\` found.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "history") {
      const activities = state.getActivities(uid, { type: "heartbeat", limit: 10 });
      if (activities.length === 0) {
        await interaction.reply({ content: "No heartbeat activity yet.", flags: MessageFlags.Ephemeral });
        return;
      }
      const lines = activities.map((a) => {
        const t = new Date(a.ts).toLocaleString();
        const dur = `${(a.duration / 1000).toFixed(1)}s`;
        const status = a.status === "success" ? "✅" : "❌";
        const preview = a.response?.slice(0, 80) || "(no output)";
        return `${status} \`${t}\` ${dur} — ${preview}`;
      });
      await interaction.reply({
        content: `**Recent heartbeat activity:**\n${lines.join("\n")}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  if (interaction.commandName === "mcp") {
    const uid = interaction.user.id;
    const url = apiUrlFor(uid);
    if (!url) {
      await interaction.reply({ content: "No sandbox assigned. Create one with `/sandbox create` first.", flags: MessageFlags.Ephemeral });
      return;
    }
    const supervisorUsername = process.env.OPENCODE_SERVER_USERNAME || "opencode";
    const auth = "Basic " + Buffer.from(`${supervisorUsername}:${process.env.OPENCODE_SERVER_PASSWORD || ""}`).toString("base64");
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ ephemeral: true });
    try {
      if (sub === "auth") {
        const name = interaction.options.getString("name", true);
        const key = interaction.options.getString("key", true);
        const res = await fetch(`${url}/mcp/auth`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: auth },
          body: JSON.stringify({ name, key }),
          signal: AbortSignal.timeout(10_000),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `supervisor API ${res.status}`);
        await interaction.editReply({
          content: `API key stored for MCP server \`${name}\`. Restarting Pi…`,
        });
        return;
      }
      if (sub === "logout") {
        const name = interaction.options.getString("name", true);
        const res = await fetch(`${url}/mcp/logout`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: auth },
          body: JSON.stringify({ name }),
          signal: AbortSignal.timeout(10_000),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `supervisor API ${res.status}`);
        await interaction.editReply({
          content: `Removed stored API key for MCP server \`${name}\`. Restarting Pi…`,
        });
        return;
      }
      if (sub === "list") {
        const res = await fetch(`${url}/mcp`, { headers: { authorization: auth }, signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`supervisor API ${res.status}`);
        const { mcp } = await res.json();
        const names = Object.keys(mcp || {});
        if (!names.length) {
          await interaction.editReply({ content: "No MCP servers configured. Add one with `/mcp add`." });
          return;
        }
        const lines = names.map((name) => {
          const e = mcp[name] || {};
          const on = e.enabled === false ? "⏸️" : "✅";
          const keyMark = e.apiKeyConfigured ? " 🔑" : "";
          if (e.type === "remote") return `${on} **${name}**${keyMark} (remote) \`${e.url || ""}\``;
          const cmd = Array.isArray(e.command) ? e.command.join(" ") : String(e.command || "");
          return `${on} **${name}**${keyMark} (local) \`${cmd}\``.slice(0, 200);
        });
        await interaction.editReply({ content: `**MCP servers:**\n${lines.join("\n")}`.slice(0, 1900) });
        return;
      }
      if (sub === "remove") {
        const name = interaction.options.getString("name", true);
        const res = await fetch(`${url}/mcp/remove`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: auth },
          body: JSON.stringify({ name }),
          signal: AbortSignal.timeout(10_000),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `supervisor API ${res.status}`);
        await interaction.editReply({ content: `Removed MCP server \`${name}\`. Restarting Pi…` });
        return;
      }
      if (sub === "add") {
        const name = interaction.options.getString("name", true);
        const type = interaction.options.getString("type", true);
        const mcpUrl = interaction.options.getString("url");
        const commandStr = interaction.options.getString("command");
        const apiKey = interaction.options.getString("key");
        const apiKeyEnv = interaction.options.getString("api_key_env");
        const apiKeyHeader = interaction.options.getString("api_key_header");
        const headersStr = interaction.options.getString("headers");
        const envStr = interaction.options.getString("environment");
        const payload = { name, type, enabled: true };
        if (apiKey) {
          payload.auth = "api_key";
          payload.apiKey = apiKey;
        }
        if (apiKeyEnv) payload.apiKeyEnv = apiKeyEnv;
        if (apiKeyHeader) payload.apiKeyHeader = apiKeyHeader;
        if (type === "remote") {
          if (!mcpUrl) throw new Error("Remote MCP requires `url`");
          payload.url = mcpUrl;
          if (headersStr) {
            let parsed;
            try { parsed = JSON.parse(headersStr); }
            catch { throw new Error("`headers` must be valid JSON object"); }
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
              throw new Error("`headers` must be valid JSON object");
            }
            payload.headers = parsed;
          }
        } else if (type === "local") {
          if (!commandStr?.trim()) throw new Error("Local MCP requires `command`");
          // Simple argv split (supports "quoted" tokens). Same rules as docker/mcp-config.mjs.
          const argv = [];
          let cur = "";
          let quote = null;
          const s = commandStr.trim();
          for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (quote) {
              if (ch === quote) quote = null;
              else if (ch === "\\" && i + 1 < s.length) cur += s[++i];
              else cur += ch;
              continue;
            }
            if (ch === '"' || ch === "'") { quote = ch; continue; }
            if (/\s/.test(ch)) { if (cur) { argv.push(cur); cur = ""; } continue; }
            if (ch === "\\" && i + 1 < s.length) { cur += s[++i]; continue; }
            cur += ch;
          }
          if (quote) throw new Error("Unclosed quote in command");
          if (cur) argv.push(cur);
          if (!argv.length) throw new Error("Local MCP `command` is empty");
          payload.command = argv;
          if (envStr) {
            try { payload.environment = JSON.parse(envStr); }
            catch { throw new Error("`environment` must be valid JSON object"); }
          }
        } else {
          throw new Error("type must be local or remote");
        }
        const res = await fetch(`${url}/mcp/add`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: auth },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10_000),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `supervisor API ${res.status}`);
        await interaction.editReply({
          content: `Added MCP server \`${name}\` (${type}). Restarting Pi so the \`mcp\` tool can use it.`,
        });
        return;
      }
    } catch (err) {
      const message2 = err?.name === "TimeoutError" ? "Supervisor request timed out." : `Error: ${err.message}`;
      await interaction.editReply({ content: `⚠️ ${message2}` });
    }
    return;
  }

  if (interaction.commandName === "statistics") {
    await statistics.handleStatisticsCommand(interaction, statisticsExtrasForUser);
    return;
  }

  if (interaction.commandName === "tailscale") {
    const uid = interaction.user.id;
    const auth = "Basic " + Buffer.from("opencode:" + (process.env.OPENCODE_SERVER_PASSWORD || "")).toString("base64");
    const url = apiUrlFor(uid);
    if (!url) {
      await interaction.reply({ content: "No sandbox found. Create one with `/sandbox create` first.", flags: MessageFlags.Ephemeral });
      return;
    }
    const sub = interaction.options.getSubcommand();
    try {
      if (sub === "key") {
        const authkey = interaction.options.getString("authkey", true);
        await interaction.deferReply({ ephemeral: true });
        const res = await fetch(`${url}/tailscale/key`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: auth },
          body: JSON.stringify({ key: authkey }),
        });
        const data = await res.json();
        if (data.success) await interaction.editReply("**Tailscale:** Connected.");
        else await interaction.editReply(`**Tailscale error:** ${data.error || "unknown"}`);
      } else if (sub === "login" || sub === "reauth") {
        await interaction.deferReply({ ephemeral: true });
        const res = await fetch(`${url}/tailscale/login`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: auth },
          body: JSON.stringify({ force: sub === "reauth" }),
        });
        const data = await res.json();
        if (data.url) {
          await interaction.editReply(
            `**Tailscale:** Open this link to authenticate your sandbox's device:\n${data.url}\n\nAfter approving, run \`/tailscale status\` to confirm.`,
          );
        } else {
          await interaction.editReply("**Tailscale:** Already authenticated (or no login URL emitted).");
        }
      } else if (sub === "status") {
        await interaction.deferReply({ ephemeral: true });
        const res = await fetch(`${url}/tailscale/status`, { headers: { authorization: auth } });
        const data = await res.json();
        if (data.error) {
          await interaction.editReply(`**Tailscale:** Not connected — ${data.error}`);
        } else {
          const self = data.Self || {};
          const peerCount = Object.keys(data.Peer || {}).length;
          const dnsName = self.DNSName || self.HostName || "unknown";
          await interaction.editReply(`**Tailscale:** Connected\n**Node:** ${dnsName}\n**Peers:** ${peerCount}`);
        }
      } else if (sub === "down") {
        await interaction.deferReply({ ephemeral: true });
        const res = await fetch(`${url}/tailscale/down`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: auth },
          body: JSON.stringify({}),
        });
        const data = await res.json();
        if (data.success) await interaction.editReply("**Tailscale:** Disconnected.");
        else await interaction.editReply(`**Tailscale error:** ${data.error || "unknown"}`);
      }
    } catch (err) {
      const message = `**Tailscale error:** ${err.message}`;
      if (interaction.deferred || interaction.replied) await interaction.editReply(message).catch(() => {});
      else await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

});

// Handle skill removal
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isStringSelectMenu() || interaction.customId !== "skill_remove") return;
  const name = interaction.values[0];
  const uid = interaction.user.id;
  const auth = "Basic " + Buffer.from("opencode:" + (process.env.OPENCODE_SERVER_PASSWORD || "")).toString("base64");
  try {
    const res = await fetch(`${apiUrlFor(uid)}/tools/remove`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `supervisor API ${res.status}`);
    }
    await interaction.update({ content: `✅ Removed skill **${name}**. The sandbox supervisor will reload tools.`, components: [] });
  } catch (err) {
    await interaction.update({ content: `⚠️ Failed to remove skill: ${err.message}`, components: [] });
  }
});

// Handle model selection dropdown
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isStringSelectMenu() || interaction.customId !== "model_select") return;
  const value = interaction.values[0];
  const uid = interaction.user.id;
  const auth = "Basic " + Buffer.from("opencode:" + (process.env.OPENCODE_SERVER_PASSWORD || "")).toString("base64");

  if (value === "__custom__") {
    try {
      const row = new ActionRowBuilder({
        components: [
          new TextInputBuilder()
            .setCustomId("model_name")
            .setLabel("Model identifier")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("provider/model-name (e.g. anthropic/claude-sonnet-4)")
            .setRequired(true),
        ],
      });
      const modal = new ModalBuilder()
        .setCustomId("custom_model")
        .setTitle("Set custom model")
        .addComponents(row);
      console.error("[model_select] showing modal...");
      await interaction.showModal(modal);
      console.error("[model_select] modal shown");
    } catch (err) {
      console.error("[model_select] showModal error:", err.message, err.stack?.split("\n")[1]);
      await interaction.reply({ content: `⚠️ ${err.message}`, flags: MessageFlags.Ephemeral });
      return;
    }
    return;
  }

  try {
    const res = await fetch(`${apiUrlFor(uid)}/model`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth },
      body: JSON.stringify({ model: value }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `supervisor API ${res.status}`);
    }
    await interaction.update({
      content: `✅ Model changed to \`${value}\`. Sandbox LLM process restarting…`,
      components: [],
    });
  } catch (err) {
    await interaction.update({ content: `⚠️ Failed to set model: ${err.message}`, components: [] });
  }
});

// Handle custom model modal submission
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isModalSubmit() || interaction.customId !== "custom_model") return;
  const model = interaction.fields.getTextInputValue("model_name").trim();
  if (!model) {
    await interaction.reply({ content: "⚠️ Model name cannot be empty.", flags: MessageFlags.Ephemeral });
    return;
  }
  const uid = interaction.user.id;
  const auth = "Basic " + Buffer.from("opencode:" + (process.env.OPENCODE_SERVER_PASSWORD || "")).toString("base64");
  try {
    const res = await fetch(`${apiUrlFor(uid)}/model`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth },
      body: JSON.stringify({ model }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `supervisor API ${res.status}`);
    }
    await interaction.reply({
      content: `✅ Model changed to \`${model}\`. Sandbox LLM process restarting…`,
      flags: MessageFlags.Ephemeral,
    });
  } catch (err) {
    await interaction.reply({ content: `⚠️ Failed to set model: ${err.message}`, flags: MessageFlags.Ephemeral });
  }
});

// Handle model edit modal submission
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isModalSubmit() || !interaction.customId.startsWith("model_edit_modal:")) return;

  const parts = interaction.customId.split(":");
  if (parts.length < 3) { await interaction.reply({ content: "\u26a0\ufe0f Could not parse provider/model from modal.", flags: MessageFlags.Ephemeral }); return; }
  const provider = parts[1].toLowerCase();
  const model = parts.slice(2).join(":");

  const uid = interaction.user.id;
  const auth = "Basic " + Buffer.from("opencode:" + (process.env.OPENCODE_SERVER_PASSWORD || "")).toString("base64");
  const apiUrl = apiUrlFor(uid);

  const name = interaction.fields.getTextInputValue("edit_name").trim() || undefined;
  const contextRaw = interaction.fields.getTextInputValue("edit_context").trim();
  const maxTokensRaw = interaction.fields.getTextInputValue("edit_maxTokens").trim();
  const reasoningRaw = interaction.fields.getTextInputValue("edit_reasoning").trim().toLowerCase();

  const context = contextRaw ? parseInt(contextRaw, 10) : undefined;
  const maxTokens = maxTokensRaw ? parseInt(maxTokensRaw, 10) : undefined;
  const reasoning = reasoningRaw === "yes" || reasoningRaw === "true" || reasoningRaw === "y" || reasoningRaw === "1" ? true : reasoningRaw === "no" || reasoningRaw === "false" || reasoningRaw === "n" || reasoningRaw === "0" ? false : undefined;

  try {
    const res = await fetch(`${apiUrl}/provider/model`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth },
      body: JSON.stringify({ provider, model, name, context, maxTokens, reasoning }),
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || `supervisor API ${res.status}`); }
    await interaction.reply({
      content: `\u2705 Model **${model}** updated on **${provider}**.`,
      flags: MessageFlags.Ephemeral,
    });
  } catch (err) {
    await interaction.reply({ content: `\u26a0\ufe0f Failed to update model: ${err.message}`, flags: MessageFlags.Ephemeral });
  }
});

const BOT_HTTP_PORT = 4098;
const BOT_HTTP_PASS = process.env.OPENCODE_SERVER_PASSWORD || "";

function botHttpAuth(req) {
  const auth = req.headers.authorization || "";
  const expected = "Basic " + Buffer.from("opencode:" + BOT_HTTP_PASS).toString("base64");
  return auth === expected;
}

async function notifyPigeonDM(recipientId, from, text) {
  try {
    const user = await client.users.fetch(recipientId);
    const dm = await user.createDM();
    await dm.send({
      content: `📬 **Pigeon message from ${from}**\n\n${text}`,
      allowedMentions: { parse: [] },
    });
    console.log(`[pigeon] notified ${recipientId} (${from}): ${text.slice(0, 80)}`);
  } catch (err) {
    console.error(`[pigeon] failed to DM ${recipientId}:`, err.message);
  }
}

async function notifyPigeonBlocked(recipientId, from, reason) {
  try {
    const user = await client.users.fetch(recipientId);
    const dm = await user.createDM();
    await dm.send(
      `Agent pigeon from **${from}** was blocked: ${reason}. Message was not executed.`,
    );
    console.log(`[pigeon] blocked agent pigeon for ${recipientId} from ${from}: ${reason}`);
  } catch (err) {
    console.error(`[pigeon] failed to DM block notice to ${recipientId}:`, err.message);
  }
}

async function notifyPigeonSender(senderSandbox, recipientId, text) {
  const uid = pigeonGate.userIdForSandboxName(senderSandbox);
  const recipientSandbox = sandboxNameForUser(recipientId);
  if (uid && recipientSandbox) await notifyPigeonDM(uid, recipientSandbox, text);
}

function pigeonEnqueueOpts(recipientId, from, hop, sandboxName) {
  return {
    userId: recipientId,
    displayName: from,
    speakerUsername: from,
    pigeonFrom: from,
    pigeonHop: hop,
    sandboxName,
    forceQueue: true,
  };
}

async function runApprovedAgentPigeon(pending, pendingId = null) {
  const { recipientId, from, text, hop } = pending;
  const hopNum = Number(hop) || 0;
  const userSettings = store.getUserSettings(recipientId);
  pigeonGate.recordPigeon(recipientId, from);

  const sandboxUrl = await ensureUserSandbox(recipientId);
  if (!sandboxUrl) {
    await notifyPigeonDM(recipientId, from, text);
    return;
  }

  try {
    const user = await client.users.fetch(recipientId);
    const dm = await user.createDM();
    const bufferSec = pigeonGate.clampBufferSeconds(userSettings.pigeonBufferSeconds);
    const intro = bufferSec
      ? `📬 **Agent pigeon from ${from}** — runs in **${bufferSec}s**. React 🛑 to cancel.\n\n${text}`
      : `📬 **Agent pigeon from ${from}**\n\n${text}`;
    const triggerMsg = await dm.send(intro);
    const sandboxName = sandbox.loadUsers().find((u) => u.userId === recipientId)?.name;

    if (bufferSec > 0) {
      await safeReact(triggerMsg, "🛑");
    }

    console.log(`[pigeon] agent wake uid=${recipientId} from=${from} hop=${hopNum} buffer=${bufferSec}s`);

    const run = async () => {
      const activeId = pendingId || buffPendingId;
      if (activeId) {
        const p = pigeonGate.getPending(activeId);
        if (p?.status === "cancelled") return;
        pigeonGate.deletePending(activeId);
      }
      await enqueueChat(
        triggerMsg,
        `${text}\n(agent pigeon task — act on the message above)`,
        [],
        pigeonEnqueueOpts(recipientId, from, hopNum, sandboxName),
      );
    };

    const buffPendingId = pendingId
      || (bufferSec > 0
        ? pigeonGate.createPending({ recipientId, from, text, hop: hopNum })
        : null);

    if (bufferSec > 0 && buffPendingId) {
      pigeonGate.updatePending(buffPendingId, { status: "approved" });
      const sched = pigeonGate.scheduleExecution({
        pendingId: buffPendingId,
        bufferSec,
        onRun: run,
        onCancel: async () => {
          await triggerMsg.edit(`🛑 **Agent pigeon cancelled** (from **${from}**).`).catch(() => {});
          await notifyPigeonSender(from, recipientId, "Your agent pigeon was cancelled during the buffer.");
        },
      });
      sched?.trackMessage(triggerMsg.id);
    } else {
      await run();
    }
  } catch (err) {
    console.error(`[pigeon] agent wake failed for ${recipientId}:`, err.message);
    await notifyPigeonDM(recipientId, from, text);
  }
}

async function sendPermissionDM(recipientId, from, text, hop) {
  const pendingId = pigeonGate.createPending({ recipientId, from, text, hop });
  const user = await client.users.fetch(recipientId);
  const dm = await user.createDM();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`pigeon_allow:${pendingId}`)
      .setLabel("Allow once")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`pigeon_deny:${pendingId}`)
      .setLabel("Deny")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`pigeon_trust:${pendingId}`)
      .setLabel(`Always allow ${from}`)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`pigeon_deny_always:${pendingId}`)
      .setLabel(`Always deny ${from}`)
      .setStyle(ButtonStyle.Secondary),
  );
  await dm.send({
    content: `📬 **Agent pigeon from ${from}** — allow your Punch to run this?\n\n${text}`,
    components: [row],
  });
  console.log(`[pigeon] permission pending ${pendingId} uid=${recipientId} from=${from}`);
}

async function handleAgentPigeon(recipientId, from, text, hop) {
  const hopNum = Number(hop) || 0;
  const assessment = assessAgentPigeon({ text, from, hop: hopNum });
  if (!assessment.allow) {
    await notifyPigeonBlocked(recipientId, from, assessment.reason);
    return;
  }

  const userSettings = store.getUserSettings(recipientId);
  if (pigeonGate.isDeniedSender({ from, userSettings })) {
    await notifyPigeonBlocked(recipientId, from, `sender **${from}** is on your deny list`);
    await notifyPigeonSender(from, recipientId, "Your agent pigeon was **blocked** — the recipient has denied pigeons from your sandbox.");
    return;
  }

  if (!userSettings.workingPigeonsEnabled) {
    await notifyPigeonDM(recipientId, from, text);
    return;
  }

  const rate = pigeonGate.checkRateLimit(recipientId, from, userSettings);
  if (!rate.ok) {
    await notifyPigeonDM(recipientId, from, `_(not run — ${rate.reason})_\n\n${text}`);
    await notifyPigeonSender(from, recipientId, `Agent pigeon was rate-limited: ${rate.reason}`);
    return;
  }

  const sandboxUrl = await ensureUserSandbox(recipientId);
  if (!sandboxUrl) {
    await notifyPigeonDM(recipientId, from, text);
    return;
  }

  if (pigeonGate.shouldSkipPermission({ from, hop: hopNum, userSettings })) {
    await runApprovedAgentPigeon({ recipientId, from, text, hop: hopNum });
    return;
  }

  await sendPermissionDM(recipientId, from, text, hopNum);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => {
      try { resolve(JSON.parse(data)); } catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

const botHttpServer = createServer(async (req, res) => {
  if (!botHttpAuth(req)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Punch API"' });
    return void res.end("Unauthorized");
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  let body;
  try {
    body = await readBody(req);
  } catch {
    body = null;
  }

  if (url.pathname === "/workers/progress" && req.method === "POST") {
    const userId = body?.userId;
    const worker = body?.worker;
    if (!userId || !worker?.id || !worker?.phase) {
      res.writeHead(400, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: "Missing userId or worker progress" }));
    }
    const phase = String(worker.phase);
    const allowed = new Set(["queued", "starting", "working", "tool", "finalizing", "timed_out", "failed"]);
    if (!allowed.has(phase)) {
      res.writeHead(400, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: "Invalid worker phase" }));
    }
    const now = Date.now();
    const key = `${userId}:${worker.id}`;
    const previous = workerProgressSent.get(key);
    if (previous && now - previous < 4_000 && phase !== "failed" && phase !== "timed_out") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ success: true, throttled: true }));
    }
    workerProgressSent.set(key, now);
    try {
      if (worker.channelId) {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ success: true, skipped: true }));
      }
      const icon = phase === "tool" ? "🛠️" : phase === "finalizing" ? "📦" : phase === "failed" || phase === "timed_out" ? "⚠️" : "⏳";
      const detail = String(worker.detail || "Working").replace(/[\r\n`]/g, " ").slice(0, 180);
      const dm = await client.users.createDM(userId);
      await dm.send(`${icon} **${worker.kind || "Pi"} worker** \`${String(worker.id).slice(0, 8)}\`: ${detail}`);
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ success: true }));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: error.message }));
    }
  }

  if (url.pathname === "/workers/complete" && req.method === "POST") {
    const userId = body?.userId;
    const worker = body?.worker;
    if (!userId || !worker?.id) {
      res.writeHead(400, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: "Missing userId or worker" }));
    }
    workerProgressSent.delete(`${userId}:${worker.id}`);
    try {
      const isSubtask = worker.source === "multitask" || worker.channelId;
      const label = isSubtask ? "subtask" : "worker";
      const icon = worker.status === "succeeded" ? "✅" : worker.status === "stopped" ? "🛑" : "⚠️";
      const detail = worker.status === "succeeded" ? (worker.result || "_(no output)_") : (worker.error || worker.result || "Worker stopped without output.");
      const content = `${icon} **${worker.kind} ${label} complete** \`${String(worker.id).slice(0, 8)}\` (${worker.status})\n${detail.slice(-1_700)}`;
      const delivered = await deliverWorkerToChannel(worker, content);
      if (!delivered) {
        const dm = await client.users.createDM(userId);
        await dm.send(content);
      }
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ success: true }));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: error.message }));
    }
  }

  if (url.pathname.startsWith("/routines")) {
    try {
      const headerUserId = req.headers["x-discord-user-id"] || null;

      if (req.method === "GET" && url.pathname === "/routines/list") {
        const userId = verifyRoutineUser(url.searchParams.get("userId"), headerUserId);
        if (!userId) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Missing userId" }));
        }
        const list = routines.listRoutines(userId);
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ routines: list }));
      }

      if (req.method === "POST" && url.pathname === "/routines/create") {
        if (!body) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Invalid JSON" }));
        }
        const userId = verifyRoutineUser(body.userId, headerUserId);
        if (!userId || !body.type || !body.payload) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Missing userId, type, or payload" }));
        }
        if (body.type !== "heartbeat" && !body.channelId) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Missing channelId (required for non-heartbeat types)" }));
        }
        const timezone = body.timezone || userTimeZone(userId);
        let schedule = body.schedule;
        if (body.when) {
          schedule = routines.parseRecurrence(body.when, body.recurrence || "once", timezone);
        }
        if (!schedule) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Missing schedule or when" }));
        }
        const routine = routines.addRoutine({
          userId,
          channelId: body.channelId,
          guildId: body.guildId || null,
          type: body.type,
          payload: body.payload,
          schedule,
          timezone,
        });
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ routine }));
      }

      const deleteMatch = url.pathname.match(/^\/routines\/([^/]+)$/);
      if (req.method === "DELETE" && deleteMatch) {
        if (!body) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Invalid JSON" }));
        }
        const userId = verifyRoutineUser(body.userId, headerUserId);
        if (!userId) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Missing userId" }));
        }
        const ok = routines.removeRoutine(deleteMatch[1], userId);
        res.writeHead(ok ? 200 : 404, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ success: ok }));
      }

      const pauseMatch = url.pathname.match(/^\/routines\/([^/]+)\/pause$/);
      if (req.method === "POST" && pauseMatch) {
        if (!body) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Invalid JSON" }));
        }
        const userId = verifyRoutineUser(body.userId, headerUserId);
        if (!userId) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Missing userId" }));
        }
        const r = routines.pauseRoutine(pauseMatch[1], userId);
        res.writeHead(r ? 200 : 404, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ routine: r }));
      }

      const resumeMatch = url.pathname.match(/^\/routines\/([^/]+)\/resume$/);
      if (req.method === "POST" && resumeMatch) {
        if (!body) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Invalid JSON" }));
        }
        const userId = verifyRoutineUser(body.userId, headerUserId);
        if (!userId) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Missing userId" }));
        }
        const r = routines.resumeRoutine(resumeMatch[1], userId);
        res.writeHead(r ? 200 : 404, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ routine: r }));
      }

      res.writeHead(404);
      return void res.end("Not Found");
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: err.message }));
    }
  }

  if (url.pathname.startsWith("/collabs")) {
    try {
      const peer = await resolvePeerSandbox(req);
      if (peer?.peer !== "sandbox" || !isRegisteredSandboxName(peer.name, sandbox.loadUsers())) {
        res.writeHead(403, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: "Collaboration calls require a registered sandbox." }));
      }
      const actor = peer.name;
      if (req.method === "POST" && url.pathname === "/collabs/create") {
        if (!body?.reviewer || !body?.workspace) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Missing reviewer or workspace." }));
        }
        const collab = await collabs.create({ owner: actor, reviewer: String(body.reviewer).toLowerCase(), workspace: body.workspace });
        const reviewerId = sandbox.loadUsers().find((user) => user.name === collab.participants[1])?.userId;
        if (reviewerId) {
          const task = String(body.task || "Review future collaboration proposals carefully, run relevant tests, and request changes until code is good.").slice(0, 3000);
          handleAgentPigeon(reviewerId, actor, `Collaboration ${collab.id} started. Your clone is ${collab.workspaces[collab.participants[1]]}. ${task}`, 0).catch(() => {});
        }
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ collab }));
      }
      if (req.method === "GET" && url.pathname === "/collabs") {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ collabs: collabs.listFor(actor) }));
      }
      const match = url.pathname.match(/^\/collabs\/(col_[a-f0-9]{12})(?:\/(propose|review))?$/);
      if (!match) {
        res.writeHead(404);
        return void res.end("Not Found");
      }
      const [, id, action] = match;
      if (req.method === "GET" && !action) {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ collab: collabs.getFor(id, actor) }));
      }
      if (!body) {
        res.writeHead(400, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
      if (req.method === "POST" && action === "propose") {
        const collab = await collabs.propose({ id, actor, head: body.head });
        const reviewer = collab.proposal.reviewer;
        const reviewerId = sandbox.loadUsers().find((user) => user.name === reviewer)?.userId;
        if (reviewerId) {
          handleAgentPigeon(reviewerId, actor, `Collaboration ${id} needs review. Fetch branch ${collab.proposal.branch} at ${collab.proposal.head}, inspect diff and tests, then use the collab tool to approve or request changes.`, 0).catch(() => {});
        }
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ collab }));
      }
      if (req.method === "POST" && action === "review") {
        const collab = await collabs.review({ id, actor, approve: body.approve === true, notes: body.notes });
        if (collab.proposal.status === "merged") {
          for (const participant of collab.participants) {
            const userId = sandbox.loadUsers().find((user) => user.name === participant)?.userId;
            if (userId) notifyPigeonDM(userId, "collab", `Collaboration **${id}** auto-merged \`${collab.base.slice(0, 12)}\` into main.`).catch(() => {});
          }
        }
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ collab }));
      }
      res.writeHead(405);
      return void res.end("Method Not Allowed");
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: error.message }));
    }
  }

  // State API endpoints
  if (url.pathname.startsWith("/state/")) {
    try {
      if (req.method === "GET" && url.pathname === "/state/activity") {
        const userId = url.searchParams.get("userId");
        if (!userId) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Missing userId" }));
        }
        const type = url.searchParams.get("type") || undefined;
        const limit = Number(url.searchParams.get("limit")) || 20;
        const activities = state.getActivities(userId, { type, limit });
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ activities }));
      }

      if (req.method === "GET" && url.pathname === "/state/stats") {
        const userId = url.searchParams.get("userId");
        if (!userId) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Missing userId" }));
        }
        const stats = state.getActivityStats(userId);
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify(stats));
      }

      if (req.method === "GET" && url.pathname === "/state/statistics") {
        const userId = url.searchParams.get("userId");
        if (!userId) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Missing userId" }));
        }
        const period = url.searchParams.get("period") || "week";
        if (!statistics.STATISTICS_PERIODS.includes(period)) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Invalid period" }));
        }
        const usage = state.getUsageStatistics(userId, period);
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify(usage));
      }

      res.writeHead(404);
      return void res.end("Not Found");
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: err.message }));
    }
  }

  if (!body) {
    res.writeHead(400);
    return void res.end("Invalid JSON");
  }

  try {
    if (req.method === "POST" && url.pathname === "/pigeon/notify") {
      const { recipientId, from, text, agent, hop } = body;
      if (!recipientId || !from || !text) {
        res.writeHead(400);
        return void res.end(JSON.stringify({ error: "Missing recipientId, from, or text" }));
      }
      const peer = await resolvePeerSandbox(req);
      const recipientSandbox = sandboxNameForUser(recipientId);
      const callerOk =
        peer?.peer === "bot" ||
        (peer?.peer === "sandbox" && recipientSandbox && peer.name === recipientSandbox);
      if (!callerOk || !isRegisteredSandboxName(from, sandbox.loadUsers())) {
        res.writeHead(403);
        return void res.end(JSON.stringify({ error: "Pigeon sender verification failed" }));
      }
      if (agent) {
        handleAgentPigeon(recipientId, from, text, hop).catch(() => {});
      } else {
        notifyPigeonDM(recipientId, from, text).catch(() => {});
      }
      res.writeHead(200);
      return void res.end(JSON.stringify({ success: true }));
    }
    res.writeHead(404);
    return void res.end("Not Found");
  } catch (err) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
});

botHttpServer.listen(BOT_HTTP_PORT, "0.0.0.0", () => {
  console.log(`Bot HTTP API listening on port ${BOT_HTTP_PORT}`);
});

client.login(TOKEN);
