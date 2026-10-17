import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { MemoryDatabase } from "./memory-db.js";
import { cleanLine, normalize, terms, matchesTerm, MEMORY_PREAMBLE_MAX_CHARS } from "./memory-text.js";

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), "data");
const SESSION_FILE = join(DATA_DIR, "sessions.json");
const THREAD_OWNERS_FILE = join(DATA_DIR, "thread-owners.json");
const CONFIG_FILE = join(DATA_DIR, "config.json");
const SECRETS_FILE = join(DATA_DIR, "secrets.json");
const DAILY_RETENTION_DAYS = 30;
const DAILY_MAX_RECORDS = 200;
const NOTE_PART_MAX_CHARS = 1_000;
const RECALL_SESSION_CACHE_MAX = 500;
const recalledCitations = new Map();

const readOnlyStores = new Set();

/**
 * PNCH-41: distinguish "file missing" from "file corrupt"/unreadable.
 * - missing       -> { ok: true, value: null } (caller uses its fallback; save() may rewrite)
 * - corrupt JSON  -> { ok: false } (file quarantined; reads get fallback, saves refused)
 * - read EACCES etc -> { ok: false } (file left in place, NOT renamed; saves still refused)
 */
function loadState(file) {
  if (!existsSync(file)) return { ok: true, value: null };
  let raw;
  try {
    // Read outside the parse try: a valid-but-temporarily-unreadable file must NOT be
    // renamed/quarantined as corrupt (cubic review).
    raw = readFileSync(file, "utf8");
  } catch (readError) {
    console.error(`[memory] ${file} unreadable this process:`, readError.message);
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (parseError) {
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch (renameError) {
      console.error(`[memory] could not quarantine corrupt ${file}:`, renameError.message);
    }
    console.error(`[memory] ${file} failed to parse — quarantined; check it before deleting. Writes to this store are disabled until the file is restored. (${parseError.message})`);
    return { ok: false };
  }
}

function load(file, fallback) {
  const state = loadState(file);
  if (state.ok) return state.value ?? fallback;
  // Corrupt or unreadable: serve the fallback for reads but mark the store read-only
  // this process, so the next save() cannot replace the real file with fallback content.
  readOnlyStores.add(file);
  return fallback;
}

function save(file, obj) {
  if (readOnlyStores.has(file)) {
    throw new Error(
      `[memory] write to ${file} refused: the original file is corrupt/unreadable and was ` +
      `quarantined this process. Restore or remove the .corrupt- file, then retry (callers must not report this write as persisted).`,
    );
  }
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

let memoryDatabase;
function database() {
  // Initialize on the first memory operation. A failed migration never enables
  // writes to an empty fallback and may be retried after restoring the source.
  return memoryDatabase ||= new MemoryDatabase(DATA_DIR);
}

export function initializeMemory() {
  database();
}

export function closeMemory() {
  memoryDatabase?.close();
  memoryDatabase = undefined;
}
let sessions = load(SESSION_FILE, {});
let threadOwners = load(THREAD_OWNERS_FILE, {});
let config = load(CONFIG_FILE, { allowedChannels: {}, summonWords: {}, guildSettings: {} });

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

function newId() {
  return randomUUID();
}

export function remember(scope, ownerId, text) {
  if (!["user", "channel"].includes(scope) || ownerId == null || !String(ownerId) || !String(text).trim()) {
    throw new Error("Memory requires a scope, owner, and nonempty text.");
  }
  const entry = { id: newId(), text: text.trim(), ts: Date.now() };
  database().insert("fact", scope, ownerId, entry);
  return entry;
}

export function forget(scope, ownerId, id) {
  return database().forget(scope, ownerId, id);
}

export function list(scope, ownerId) {
  return database().list(scope, ownerId);
}

function dateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function searchMemory({ userId, channelId, query = "", isDm = false, limit = 10 } = {}) {
  const queryTerms = terms(query);
  if (!queryTerms.length) return [];
  const cutoff = dateKey(new Date(Date.now() - (DAILY_RETENTION_DAYS - 1) * 86_400_000));
  const records = database().search({ userId, channelId, isDm, queryTerms, cutoff });
  const now = Date.now();
  const documentFrequency = new Map();
  for (const record of records) {
    const recordTerms = new Set(terms(record.text));
    for (const term of queryTerms) {
      if ([...recordTerms].some((word) => matchesTerm(word, term))) {
        documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
      }
    }
  }

  const ranked = [];
  for (const record of records) {
    const text = cleanLine(record.text);
    const recordTerms = terms(text);
    let keywordScore = 0;
    const matches = [];
    for (const term of queryTerms) {
      const exactCount = recordTerms.filter((word) => word === term).length;
      const partial = exactCount === 0 && recordTerms.some((word) => matchesTerm(word, term));
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
  const maxChars = Math.max(0, Math.min(MEMORY_PREAMBLE_MAX_CHARS, Number(options.maxChars ?? 3_500) || 0));
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

  return database().transaction(() => {
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
      database().insert("fact", "user", userId, {
        id: newId(), text,
        ts: Number.isFinite(Number(record.ts)) ? Number(record.ts) : Date.now(),
        origin: String(record.origin || document.source || source).slice(0, 120),
      });
      existing.add(key);
      imported += 1;
    }
    // Preserve the explicit import API's dedupe behavior, inside the same transaction.
    const entries = list("user", userId);
    const keep = new Set(dedupeEntries(entries).map((entry) => entry.id));
    for (const entry of entries) if (!keep.has(entry.id)) database().forget("user", userId, entry.id);
    const after = list("user", userId).length;
    return { imported, skipped, before, after, removed: before + imported - after };
  });
}

export function compactMemory({ userId, channelId } = {}) {
  return database().transaction(() => {
    const removed = [];
    const before = [];
    for (const [scope, ownerId] of [["user", userId], ["channel", channelId]]) {
      const entries = list(scope, ownerId);
      before.push(entries.length);
      const keep = new Set(dedupeEntries(entries).map((entry) => entry.id));
      for (const entry of entries) if (!keep.has(entry.id)) database().forget(scope, ownerId, entry.id);
      removed.push(entries.length - keep.size);
    }
    const total = before[0] + before[1];
    return { before: total, after: total - removed[0] - removed[1],
      removed: removed[0] + removed[1], userRemoved: removed[0], channelRemoved: removed[1] };
  });
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
  // Dots inside names/URLs are not sentence boundaries. Skip an entire question
  // before matching a fact prefix, so its declarative-looking tail is not saved.
  const sentences = String(userText || "").split(/(?<=[.!?])(?:[ \t]+|$)|[\r\n]+/u);
  const pattern = /\b(?:my name is|i prefer|my time ?zone is|i use|remember that)\s+.+/i;
  const facts = [];
  const seen = new Set();
  for (const sentence of sentences) {
    if (/\?\s*$/.test(sentence)) continue;
    const match = sentence.match(pattern);
    if (!match) continue;
    const fact = cleanLine(match[0]).replace(/[.!]$/, "");
    const key = normalize(fact);
    if (!fact || fact.length > 260 || containsSensitive(fact) || seen.has(key)) continue;
    seen.add(key);
    facts.push(fact);
    if (facts.length === 3) break;
  }
  return facts;
}

export function captureConversation({ userId, channelId, isDm, userText, assistantText, extractDurableFacts = true } = {}) {
  if (!isDm) return { notesAdded: 0, factsAdded: 0, facts: [] };
  if (userId == null || channelId == null || !String(userId) || !String(channelId)) {
    throw new Error("Daily memory requires user and channel ownership.");
  }
  return database().transaction(() => {
    const today = dateKey();
    const safeUser = safeNotePart(userText);
    const safeAssistant = safeNotePart(assistantText);
    let notesAdded = 0;
    if (safeUser || safeAssistant) {
      const entry = {
        id: newId(), userId: String(userId), channelId: String(channelId),
        text: cleanLine(`User: ${safeUser}${safeAssistant ? ` Assistant: ${safeAssistant}` : ""}`),
        userText: safeUser, assistantText: safeAssistant, ts: Date.now(), date: today,
      };
      database().insert("daily", "dm", userId, entry, channelId, today);
      const cutoff = dateKey(new Date(Date.now() - (DAILY_RETENTION_DAYS - 1) * 86_400_000));
      database().pruneDaily(userId, channelId, today, cutoff, DAILY_MAX_RECORDS);
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
  });
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

// Which user summoned a Punch-owned thread. Auto-summon inside the thread is
// restricted to them — the thread's session lives in their sandbox, and other
// members' messages shouldn't silently inject into it.
export function getThreadOwner(threadId) {
  return threadOwners[threadId] || null;
}

export function setThreadOwner(threadId, userId) {
  if (!threadId || !userId) return;
  threadOwners[threadId] = userId;
  save(THREAD_OWNERS_FILE, threadOwners);
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
