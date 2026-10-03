import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), "data");
const MEM_FILE = join(DATA_DIR, "memory.json");
const SESSION_FILE = join(DATA_DIR, "sessions.json");
const CONFIG_FILE = join(DATA_DIR, "config.json");
const SECRETS_FILE = join(DATA_DIR, "secrets.json");
const DAILY_DIR = join(DATA_DIR, "memory");
const DAILY_RETENTION_DAYS = 30;
const DAILY_MAX_RECORDS = 200;
const NOTE_PART_MAX_CHARS = 1_000;
const RECALL_SESSION_CACHE_MAX = 500;
const recalledCitations = new Map();

function load(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function save(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(obj, null, 2));
    renameSync(temp, file);
  } catch (error) {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}

let mem = load(MEM_FILE, { users: {}, channels: {} });
let sessions = load(SESSION_FILE, {});
let config = load(CONFIG_FILE, { allowedChannels: {}, summonWords: {}, guildSettings: {} });

// Tolerate old or partially-written memory documents without changing their format.
if (!mem || typeof mem !== "object") mem = {};
if (!mem.users || typeof mem.users !== "object") mem.users = {};
if (!mem.channels || typeof mem.channels !== "object") mem.channels = {};

export const GUILD_SETTINGS_DEFAULTS = {
  reactionSummonEmoji: "🤖",
  reactionSummonEnabled: true,
  reactionProgressEnabled: true,
  reactionProgressMode: "both", // inert (lifecycle reactions removed; progress is the live status message)
  contextMode: "channel", // "channel" (legacy) | "thread" (reply-thread scoped)
};

export const USER_SETTINGS_DEFAULTS = {
  workingPigeonsEnabled: true,
  pigeonDonePigeon: true,
  pigeonDoneDm: true,
  pigeonDoneAgent: false,
  pigeonAskUnknown: true,
  pigeonBufferSeconds: 0,
  pigeonRateLimitCount: 5,
  pigeonRateLimitWindowMs: 600_000,
  trustedPigeonSenders: [],
  deniedPigeonSenders: [],
  disableIdleTimeout: false,
  allowBots: false,
  noThinking: false,
  showContext: false,
  gitCoAuthor: true,
  multitaskEnabled: false,
  multitaskWorkersCap: 3,
  threadModeEnabled: false,
  steeringEnabled: false,
  autoCompressThreshold: 75,
  timeZone: "UTC",
};

let seq = 0;
function newId() {
  seq += 1;
  return (Date.now().toString(36) + seq.toString(36)).slice(-6);
}

function bank(scope) {
  return scope === "channel" ? mem.channels : mem.users;
}

export function remember(scope, ownerId, text) {
  const b = bank(scope);
  if (!b[ownerId]) b[ownerId] = [];
  const entry = { id: newId(), text: text.trim(), ts: Date.now() };
  b[ownerId].push(entry);
  save(MEM_FILE, mem);
  return entry;
}

export function forget(scope, ownerId, id) {
  const b = bank(scope);
  const entries = b[ownerId];
  if (!entries) return false;
  const i = entries.findIndex((e) => e.id === id);
  if (i < 0) return false;
  entries.splice(i, 1);
  save(MEM_FILE, mem);
  return true;
}

export function list(scope, ownerId) {
  return bank(scope)[ownerId] || [];
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "how",
  "i", "in", "is", "it", "me", "my", "of", "on", "or", "that", "the", "this", "to",
  "was", "what", "when", "where", "which", "who", "with", "you", "your",
]);

function terms(text) {
  const words = String(text || "").toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu) || [];
  const useful = words.filter((word) => word.length > 1 && !STOP_WORDS.has(word));
  return [...new Set(useful.length ? useful : words.filter((word) => word.length > 1))];
}

function cleanLine(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function normalize(text) {
  return cleanLine(text)
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function dailyFile(date) {
  return join(DAILY_DIR, `${date}.json`);
}

function readDailyRecords(userId, channelId) {
  if (!existsSync(DAILY_DIR)) return [];
  const cutoff = dateKey(new Date(Date.now() - (DAILY_RETENTION_DAYS - 1) * 86_400_000));
  const records = [];
  for (const name of readdirSync(DAILY_DIR)) {
    const match = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(name);
    if (!match || match[1] < cutoff) continue;
    const document = load(join(DAILY_DIR, name), { records: [] });
    const entries = Array.isArray(document) ? document : document.records;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (String(entry.userId) !== String(userId) || String(entry.channelId) !== String(channelId)) continue;
      records.push({ ...entry, date: entry.date || match[1] });
    }
  }
  return records;
}

function candidates({ userId, channelId, isDm }) {
  const records = [];
  for (const entry of list("user", userId)) {
    records.push({ ...entry, scope: "user", source: "durable", citation: `[memory:user:${entry.id}]` });
  }
  for (const entry of list("channel", channelId)) {
    records.push({ ...entry, scope: "channel", source: "durable", citation: `[memory:channel:${entry.id}]` });
  }
  if (isDm) {
    for (const entry of readDailyRecords(userId, channelId)) {
      records.push({
        ...entry,
        text: entry.text || [entry.userText, entry.assistantText].filter(Boolean).join(" / "),
        scope: "dm",
        source: "daily",
        citation: `[daily:${entry.date}:${entry.id}]`,
      });
    }
  }
  return records.filter((record) => cleanLine(record.text));
}

export function searchMemory({ userId, channelId, query = "", isDm = false, limit = 10 } = {}) {
  const records = candidates({ userId, channelId, isDm });
  const queryTerms = terms(query);
  const now = Date.now();
  const documentFrequency = new Map();
  for (const record of records) {
    const recordTerms = new Set(terms(record.text));
    for (const term of queryTerms) {
      if (recordTerms.has(term) || cleanLine(record.text).toLowerCase().includes(term)) {
        documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
      }
    }
  }

  const ranked = [];
  for (const record of records) {
    const text = cleanLine(record.text);
    const lower = text.toLowerCase();
    const recordTerms = terms(text);
    let keywordScore = 0;
    const matches = [];
    for (const term of queryTerms) {
      const exactCount = recordTerms.filter((word) => word === term).length;
      const partial = exactCount === 0 && lower.includes(term);
      if (!exactCount && !partial) continue;
      const df = documentFrequency.get(term) || 0;
      const idf = Math.log(1 + (records.length + 1) / (df + 1));
      keywordScore += idf * (exactCount ? 2 : 0.8);
      matches.push(term);
    }
    if (queryTerms.length && matches.length === 0) continue;

    const ageDays = Math.max(0, (now - Number(record.ts || 0)) / 86_400_000);
    const recencyBoost = 1 / (1 + ageDays / 30);
    const sourceBoost = record.source === "durable" ? 0.45 : 0.15;
    const scopeBoost = record.scope === "user" ? 0.1 : 0;
    const score = keywordScore + recencyBoost + sourceBoost + scopeBoost;
    const reason = queryTerms.length
      ? `matched ${matches.map((term) => `“${term}”`).join(", ")}; ${record.source} source; ${ageDays < 1 ? "recent" : `${Math.round(ageDays)}d old`}`
      : `${record.source} ${record.scope} record; ${ageDays < 1 ? "recent" : `${Math.round(ageDays)}d old`}`;
    ranked.push({
      id: record.id,
      text,
      scope: record.scope,
      source: record.source,
      citation: record.citation,
      score: Number(score.toFixed(6)),
      reason,
      ts: Number(record.ts || 0),
    });
  }

  const count = Math.max(0, Math.min(100, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 10));
  return ranked
    .sort((a, b) => b.score - a.score || b.ts - a.ts || String(a.id).localeCompare(String(b.id)))
    .slice(0, count);
}

export function explainMemory(args) {
  return searchMemory(args).map((result) => ({ ...result, reason: `Score ${result.score}: ${result.reason}.` }));
}

export function preamble(userId, channelId, query = "", options = {}) {
  const maxChars = Math.max(0, Math.min(20_000, Number(options.maxChars ?? 3_500) || 0));
  const limit = Math.max(0, Math.min(100, Number(options.limit ?? 10) || 0));
  if (!maxChars || !limit) return "";
  const recallSessionId = options.recallSessionId ? String(options.recallSessionId) : null;
  let recalled = null;
  if (recallSessionId) {
    recalled = recalledCitations.get(recallSessionId);
    if (!recalled) {
      recalled = new Set();
      recalledCitations.set(recallSessionId, recalled);
      // Recall state is an optimization only; discard oldest sessions first.
      if (recalledCitations.size > RECALL_SESSION_CACHE_MAX) {
        recalledCitations.delete(recalledCitations.keys().next().value);
      }
    }
  }
  // Get enough candidates that recalled entries cannot hide useful ones.
  const results = searchMemory({ userId, channelId, query, isDm: options.isDm === true, limit: 100 });
  const lines = [];
  let used = 0;
  for (const result of results) {
    if (recalled?.has(result.citation)) continue;
    let line = `- ${result.citation} ${result.text}`;
    const separator = lines.length ? 1 : 0;
    const available = maxChars - used - separator;
    if (available <= 0) break;
    if (line.length > available) {
      const prefix = `- ${result.citation} `;
      if (available <= prefix.length) break;
      line = `${prefix}${result.text.slice(0, Math.max(0, available - prefix.length - 1)).trimEnd()}…`;
    }
    lines.push(line);
    used += line.length + separator;
    recalled?.add(result.citation);
    if (lines.length >= limit) break;
  }
  return lines.join("\n");
}

export function moveMemoryRecall(fromSessionId, toSessionId) {
  const from = String(fromSessionId || "");
  const to = String(toSessionId || "");
  if (!from || !to || from === to) return;
  const recalled = recalledCitations.get(from);
  if (!recalled) return;
  const destination = recalledCitations.get(to) || new Set();
  for (const citation of recalled) destination.add(citation);
  recalledCitations.set(to, destination);
  recalledCitations.delete(from);
}

export function clearMemoryRecall(sessionId) {
  if (sessionId) recalledCitations.delete(String(sessionId));
}

function dedupeEntries(entries) {
  const seen = new Set();
  const kept = [];
  const ordered = [...entries].sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
  for (const entry of ordered) {
    const key = normalize(entry.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    kept.push(entry);
  }
  return kept.sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
}

export function exportUserMemory(userId, { source = "punch" } = {}) {
  const records = dedupeEntries(list("user", userId))
    .filter((entry) => cleanLine(entry.text) && !containsSensitive(entry.text))
    .map((entry) => ({
      text: cleanLine(entry.text),
      ts: Number.isFinite(Number(entry.ts)) ? Number(entry.ts) : Date.now(),
      ...(entry.origin ? { origin: String(entry.origin).slice(0, 120) } : {}),
    }));
  return {
    format: "punch-memory-v1",
    scope: "user",
    ownerId: String(userId),
    source: String(source).slice(0, 120),
    exportedAt: Date.now(),
    records,
  };
}

export function importUserMemory(userId, document, { source = "import" } = {}) {
  if (!document || typeof document !== "object" || document.format !== "punch-memory-v1" || document.scope !== "user") {
    throw new Error("Not a valid Punch user-memory export.");
  }
  if (String(document.ownerId) !== String(userId)) {
    throw new Error("This memory export belongs to a different Discord user.");
  }
  if (!Array.isArray(document.records) || document.records.length > 5_000) {
    throw new Error("Memory export has an invalid record count.");
  }

  const before = list("user", userId).length;
  const existing = new Set(list("user", userId).map((entry) => normalize(entry.text)));
  let imported = 0;
  let skipped = 0;
  for (const record of document.records) {
    const text = cleanLine(record?.text);
    const key = normalize(text);
    if (!text || text.length > 2_000 || containsSensitive(text) || existing.has(key)) {
      skipped += 1;
      continue;
    }
    if (!mem.users[userId]) mem.users[userId] = [];
    mem.users[userId].push({
      id: newId(),
      text,
      ts: Number.isFinite(Number(record.ts)) ? Number(record.ts) : Date.now(),
      origin: String(record.origin || document.source || source).slice(0, 120),
    });
    existing.add(key);
    imported += 1;
  }
  if (mem.users[userId]) mem.users[userId] = dedupeEntries(mem.users[userId]);
  const after = list("user", userId).length;
  if (after !== before || imported) save(MEM_FILE, mem);
  return { imported, skipped, before, after, removed: before + imported - after };
}

export function compactMemory({ userId, channelId } = {}) {
  const userBefore = list("user", userId).length;
  const channelBefore = list("channel", channelId).length;
  if (userId != null && mem.users[userId]) mem.users[userId] = dedupeEntries(mem.users[userId]);
  if (channelId != null && mem.channels[channelId]) mem.channels[channelId] = dedupeEntries(mem.channels[channelId]);
  const userAfter = list("user", userId).length;
  const channelAfter = list("channel", channelId).length;
  const stats = {
    before: userBefore + channelBefore,
    after: userAfter + channelAfter,
    removed: userBefore + channelBefore - userAfter - channelAfter,
    userRemoved: userBefore - userAfter,
    channelRemoved: channelBefore - channelAfter,
  };
  if (stats.removed) save(MEM_FILE, mem);
  return stats;
}

const SENSITIVE_RE = /(?:api[_ -]?key|password|passwd|secret|access[_ -]?token|auth(?:orization)?[_ -]?token|bearer)\s*(?:is|=|:)?\s*[^\s,;]+|\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/gi;

function containsSensitive(text) {
  SENSITIVE_RE.lastIndex = 0;
  return SENSITIVE_RE.test(String(text || ""));
}

function safeNotePart(text) {
  const value = cleanLine(text).slice(0, NOTE_PART_MAX_CHARS);
  SENSITIVE_RE.lastIndex = 0;
  return value.replace(SENSITIVE_RE, "[REDACTED]");
}

function extractFacts(userText) {
  const text = String(userText || "");
  const patterns = [
    /\bmy name is\s+([^\n.!?]{1,100})/gi,
    /\bi prefer\s+([^\n.!?]{1,180})/gi,
    /\bmy time ?zone is\s+([^\n.!?]{1,80})/gi,
    /\bi use\s+([^\n.!?]{1,180})/gi,
    /\bremember that\s+([^\n.!?]{1,240})/gi,
  ];
  const facts = [];
  const seen = new Set();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const fact = cleanLine(match[0]);
      const key = normalize(fact);
      if (!fact || containsSensitive(fact) || seen.has(key)) continue;
      seen.add(key);
      facts.push(fact);
    }
  }
  return facts;
}

function pruneDailyFiles(today) {
  if (!existsSync(DAILY_DIR)) return;
  const cutoff = dateKey(new Date(new Date(`${today}T00:00:00.000Z`).getTime() - (DAILY_RETENTION_DAYS - 1) * 86_400_000));
  for (const name of readdirSync(DAILY_DIR)) {
    const match = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(name);
    if (match && match[1] < cutoff) unlinkSync(join(DAILY_DIR, name));
  }
}

export function captureConversation({ userId, channelId, isDm, userText, assistantText, extractDurableFacts = true } = {}) {
  if (!isDm) return { notesAdded: 0, factsAdded: 0, facts: [] };

  const today = dateKey();
  const file = dailyFile(today);
  const document = load(file, { date: today, records: [] });
  const records = Array.isArray(document.records) ? document.records : [];
  const safeUser = safeNotePart(userText);
  const safeAssistant = safeNotePart(assistantText);
  let notesAdded = 0;
  if (safeUser || safeAssistant) {
    records.push({
      id: newId(),
      userId: String(userId),
      channelId: String(channelId),
      text: cleanLine(`User: ${safeUser}${safeAssistant ? ` Assistant: ${safeAssistant}` : ""}`),
      userText: safeUser,
      assistantText: safeAssistant,
      ts: Date.now(),
      date: today,
    });
    document.date = today;
    document.records = records.slice(-DAILY_MAX_RECORDS);
    save(file, document);
    pruneDailyFiles(today);
    notesAdded = 1;
  }

  const existing = new Set(list("user", userId).map((entry) => normalize(entry.text)));
  const facts = [];
  for (const fact of extractDurableFacts ? extractFacts(userText) : []) {
    const key = normalize(fact);
    if (existing.has(key)) continue;
    remember("user", userId, fact);
    existing.add(key);
    facts.push(fact);
  }
  return { notesAdded, factsAdded: facts.length, facts };
}

export function getSession(channelId) {
  return sessions[channelId] || null;
}

export function setSession(channelId, sessionId) {
  if (!sessionId) return;
  sessions[channelId] = sessionId;
  save(SESSION_FILE, sessions);
}

export function clearSession(channelId) {
  clearMemoryRecall(sessions[channelId]);
  delete sessions[channelId];
  save(SESSION_FILE, sessions);
}

export function setAllowedChannel(guildId, channelId) {
  if (!guildId) return false;
  config.allowedChannels[guildId] = channelId;
  save(CONFIG_FILE, config);
  return true;
}

export function getAllowedChannel(guildId) {
  return config.allowedChannels[guildId] || null;
}

export function clearAllowedChannel(guildId) {
  delete config.allowedChannels[guildId];
  save(CONFIG_FILE, config);
}

export function setSummonWord(guildId, word) {
  if (!guildId) return false;
  config.summonWords[guildId] = word.toLowerCase();
  save(CONFIG_FILE, config);
  return true;
}

export function getSummonWord(guildId) {
  return config.summonWords[guildId] || null;
}

export function clearSummonWord(guildId) {
  delete config.summonWords[guildId];
  save(CONFIG_FILE, config);
}

// Per-user summon words — each user gets their own trigger keyword
export function setUserTrigger(userId, word) {
  if (!userId) return false;
  if (!config.userTriggers) config.userTriggers = {};
  if (word) {
    config.userTriggers[userId] = word.toLowerCase();
  } else {
    delete config.userTriggers[userId];
  }
  save(CONFIG_FILE, config);
  return true;
}

export function getUserTrigger(userId) {
  return config.userTriggers?.[userId] || null;
}

// Environment variables for the sandbox (stored in shared config)
export function setEnvVar(guildId, key, value) {
  if (!guildId) return false;
  if (!config.envVars) config.envVars = {};
  config.envVars[key] = value;
  save(CONFIG_FILE, config);
  return true;
}

export function getEnvVar(key) {
  return config.envVars?.[key] || null;
}

export function getEnvVars() {
  return config.envVars || {};
}

export function clearEnvVar(key) {
  if (config.envVars) {
    delete config.envVars[key];
    save(CONFIG_FILE, config);
  }
}

export function getGuildSettings(guildId) {
  if (!guildId) return { ...GUILD_SETTINGS_DEFAULTS };
  if (!config.guildSettings) config.guildSettings = {};
  const stored = config.guildSettings[guildId] || {};
  return { ...GUILD_SETTINGS_DEFAULTS, ...stored };
}

export function patchGuildSettings(guildId, partial) {
  if (!guildId) return false;
  if (!config.guildSettings) config.guildSettings = {};
  config.guildSettings[guildId] = { ...getGuildSettings(guildId), ...partial };
  save(CONFIG_FILE, config);
  return true;
}

export function getUserSettings(userId) {
  if (!userId) return { ...USER_SETTINGS_DEFAULTS };
  if (!config.userSettings) config.userSettings = {};
  const stored = config.userSettings[userId] || {};
  return { ...USER_SETTINGS_DEFAULTS, ...stored };
}

export function patchUserSettings(userId, partial) {
  if (!userId) return false;
  if (!config.userSettings) config.userSettings = {};
  config.userSettings[userId] = { ...getUserSettings(userId), ...partial };
  save(CONFIG_FILE, config);
  return true;
}
