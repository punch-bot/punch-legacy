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
const DAILY_RETENTION_DAYS = 30;
const DAILY_MAX_RECORDS = 200;
const NOTE_PART_MAX_CHARS = 1_000;
const RECALL_SESSION_CACHE_MAX = 500;
const recalledCitations = new Map();

const readOnlyStores = new Set();

function loadState(file) {
  if (!existsSync(file)) return { ok: true, value: null };
  let raw;
  try {
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
    } catch {}
    throw error;
  }
}

let memoryDatabase;
let memoryFailure;
function database() {
  if (memoryFailure) throw memoryFailure;
  try {
    return memoryDatabase ||= new MemoryDatabase(DATA_DIR);
  } catch (error) {
    memoryFailure = Object.assign(new Error(`[memory] store unavailable: ${error.message}`), { code: "MEMORY_UNAVAILABLE", status: 503 });
    throw memoryFailure;
  }
}

export function initializeMemory({ strict = true } = {}) {
  memoryFailure = undefined;
  try { database(); } catch (error) {
    if (strict) throw error;
  }
  return getMemoryStatus();
}

export function getMemoryStatus() {
  return { available: !memoryFailure, initialized: Boolean(memoryDatabase), error: memoryFailure?.message || null };
}

export function closeMemory() {
  memoryDatabase?.close();
  memoryDatabase = undefined;
  memoryFailure = undefined;
}
let sessions = load(SESSION_FILE, {});
let threadOwners = load(THREAD_OWNERS_FILE, {});
let config = load(CONFIG_FILE, { allowedChannels: {}, summonWords: {}, guildSettings: {} });

export const GUILD_SETTINGS_DEFAULTS = {
  reactionSummonEmoji: "🤖",
  reactionSummonEnabled: true,
  reactionProgressEnabled: true,
  reactionProgressMode: "both",
  contextMode: "channel",
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
  multitaskWorkersCap: 3,
  threadModeEnabled: false,
  steeringEnabled: true,
  autoCompressThreshold: 75,
  timeZone: "UTC",
};

const configIsObject = config && typeof config === "object" && !Array.isArray(config);
if (configIsObject && !config.steeringDefaultOn && !readOnlyStores.has(CONFIG_FILE)) {
  for (const stored of Object.values(config.userSettings || {})) {
    if (!stored) continue;
    if (stored.steeringEnabled === false) delete stored.steeringEnabled;
    delete stored.multitaskEnabled;
    for (const [key, value] of Object.entries(stored)) {
      if (key in USER_SETTINGS_DEFAULTS && JSON.stringify(value) === JSON.stringify(USER_SETTINGS_DEFAULTS[key])) {
        delete stored[key];
      }
    }
  }
  config.steeringDefaultOn = true;
  try { save(CONFIG_FILE, config); } catch (error) {
    console.error(`[memory] settings migration not saved: ${error.message}`);
  }
}

function newId() {
  return randomUUID();
}

const SINGLE_VALUE_FACTS = [/^my name is /, /^my time ?zone is /];

function singleValueKey(text) {
  const key = normalize(text);
  return SINGLE_VALUE_FACTS.find((pattern) => pattern.test(key)) || null;
}

function supersedeSingleValue(db, scope, ownerId, keep) {
  const key = singleValueKey(keep.text);
  if (!key) return keep;
  const others = db.list(scope, ownerId).filter((entry) => entry.id !== keep.id && key.test(normalize(entry.text)));
  for (const entry of others) db.forget(scope, ownerId, entry.id);
  if (keep.pinned !== true && others.some((entry) => entry.pinned === true)) db.pin(scope, ownerId, keep.id, true);
  return others.length ? db.fact(scope, ownerId, keep.id) : keep;
}

function storeFact(scope, ownerId, text, { pinned = false } = {}) {
  if (!["user", "channel"].includes(scope) || ownerId == null || !String(ownerId) || !String(text).trim()) {
    throw new Error("Memory requires a scope, owner, and nonempty text.");
  }
  const db = database();
  return db.transaction(() => {
    const [existing] = db.sameFacts(scope, ownerId, text);
    let id = existing?.id;
    if (existing) db.reassert(scope, ownerId, id, pinned);
    else {
      id = newId();
      db.insert("fact", scope, ownerId, { id, text: text.trim(), ts: Date.now(), ...(pinned ? { pinned: true } : {}) });
    }
    return { entry: supersedeSingleValue(db, scope, ownerId, db.fact(scope, ownerId, id)), created: !existing };
  });
}

export function remember(scope, ownerId, text, options = {}) {
  return storeFact(scope, ownerId, text, options).entry;
}

export function reviseMemory(scope, ownerId, id, text) {
  const db = database();
  return db.transaction(() => {
    const current = db.fact(scope, ownerId, id);
    if (!current) return null;
    const value = cleanLine(text);
    if (!value) throw new Error("Memory requires nonempty text.");
    const duplicate = db.sameFacts(scope, ownerId, value).find((entry) => entry.id !== current.id);
    if (duplicate) {
      db.forget(scope, ownerId, current.id);
      db.reassert(scope, ownerId, duplicate.id, current.pinned === true);
      return supersedeSingleValue(db, scope, ownerId, db.fact(scope, ownerId, duplicate.id));
    }
    db.revise(scope, ownerId, current.id, value);
    return supersedeSingleValue(db, scope, ownerId, db.fact(scope, ownerId, current.id));
  });
}

export function forget(scope, ownerId, id) {
  return database().forget(scope, ownerId, id);
}

export function list(scope, ownerId) {
  return database().list(scope, ownerId);
}

export function pinMemory(scope, ownerId, id, pinned = true) {
  return database().pin(scope, ownerId, id, Boolean(pinned));
}

function coreProfileLines(userId) {
  const lines = [];
  const timeZone = config.userSettings?.[userId]?.timeZone;
  if (timeZone) lines.push({ id: null, line: `- Configured time zone: ${cleanLine(timeZone).slice(0, 80)}` });
  let entries;
  try { entries = database().coreFacts(userId); } catch {
    return lines;
  }
  const seen = new Set();
  let used = lines.map((item) => item.line).join("\n").length;
  for (const entry of entries) {
    if (containsSensitive(entry.text)) continue;
    const text = `${entry.confirmed ? "" : "(unconfirmed) "}${cleanLine(entry.text)}`;
    const key = normalize(entry.text);
    if (seen.has(key)) continue;
    seen.add(key);
    const available = 600 - used - (lines.length ? 1 : 0);
    if (available < 4 || lines.length >= 5) break;
    const budget = Math.min(available, 180);
    const line = text.length + 2 > budget ? `- ${text.slice(0, budget - 3).trimEnd()}…` : `- ${text}`;
    lines.push({ id: entry.id, line });
    used += line.length + (lines.length > 1 ? 1 : 0);
  }
  return lines;
}

export function coreProfile(userId) {
  return coreProfileLines(userId).map((item) => item.line).join("\n");
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
      ownerId: record.ownerId,
      confirmed: record.confirmed,
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
      if (recalledCitations.size > RECALL_SESSION_CACHE_MAX) {
        recalledCitations.delete(recalledCitations.keys().next().value);
      }
    }
  }
  const results = searchMemory({ userId, channelId, query, isDm: options.isDm === true, limit: 100 });
  const lines = [];
  const used = [];
  let usedChars = 0;
  for (const result of results) {
    if (recalled?.has(result.citation)) continue;
    let line = `- ${result.citation} ${result.confirmed ? "" : "(unconfirmed) "}${result.text}`;
    const separator = lines.length ? 1 : 0;
    const available = maxChars - usedChars - separator;
    if (available <= 0) break;
    if (line.length > available) {
      const prefix = `- ${result.citation} ${result.confirmed ? "" : "(unconfirmed) "}`;
      if (available <= prefix.length) break;
      line = `${prefix}${result.text.slice(0, Math.max(0, available - prefix.length - 1)).trimEnd()}…`;
    }
    lines.push(line);
    usedChars += line.length + separator;
    if (result.source === "durable") used.push({ scope: result.scope, ownerId: result.ownerId, id: result.id });
    recalled?.add(result.citation);
    if (lines.length >= limit) break;
  }
  if (options.markUsed && used.length) {
    try { database().markUsed(used); } catch (error) {
      console.warn(`[memory] could not record recall use: ${error.code || error.name || "write error"}`);
    }
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
  const ordered = [...entries].sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true) || Number(b.ts || 0) - Number(a.ts || 0));
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
      ...(entry.pinned === true ? { pinned: true } : {}),
      ...(entry.confirmed === false ? { confirmed: false } : {}),
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
        ...(record.pinned === true ? { pinned: true } : {}),
        ...(record.confirmed === false ? { confirmed: false } : {}),
      }, "", "", Date.now());
      existing.add(key);
      imported += 1;
    }
    const entries = list("user", userId);
    const keep = new Set(dedupeEntries(entries).map((entry) => entry.id));
    for (const entry of entries) if (!keep.has(entry.id)) database().forget("user", userId, entry.id);
    const newest = new Map();
    for (const entry of list("user", userId).sort((a, b) => b.ts - a.ts)) {
      const key = singleValueKey(entry.text);
      if (key && !newest.has(key)) newest.set(key, entry);
    }
    for (const entry of newest.values()) supersedeSingleValue(database(), "user", userId, entry);
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

const AUDIT_NOTE_DAYS = 7;
const AUDIT_NOTE_LIMIT = 60;
const AUDIT_FACT_LIMIT = 400;
const AUDIT_CHANGE_LIMIT = 200;
const AUDIT_OPS = new Set(["add", "merge", "drop", "fix", "flag"]);

export function newAuditRun() {
  return { since: Date.now(), touched: new Map(), totals: { added: 0, merged: 0, dropped: 0, fixed: 0, flagged: 0, skipped: 0 } };
}

const auditKey = (userId) => `audit:${userId}`;
const auditDay = (ms) => (Number.isFinite(ms) ? dateKey(new Date(ms)) : "never");

export function memoryAuditSnapshot(userId, offset = 0) {
  const facts = list("user", userId);
  const start = Math.min(Math.max(0, Math.floor(Number(offset) || 0)), facts.length);
  const profileIds = new Set(coreProfileLines(userId).map((item) => item.id).filter(Boolean));
  const since = dateKey(new Date(Date.now() - (AUDIT_NOTE_DAYS - 1) * 86_400_000));
  const notes = database().recentDaily(userId, since, AUDIT_NOTE_LIMIT);
  const factLines = facts.slice(start, start + AUDIT_FACT_LIMIT).map((entry) => {
    const flags = [entry.pinned === true && "pinned", !entry.confirmed && "unconfirmed", profileIds.has(entry.id) && "core profile"].filter(Boolean);
    return `- [fact:${entry.id}] ${cleanLine(entry.text)} (saved ${auditDay(entry.ts)}, last seen ${auditDay(entry.lastSeen)}, last recalled ${auditDay(entry.lastUsed)}${flags.length ? `, ${flags.join(", ")}` : ""})`;
  });
  const noteLines = notes.map((note) => `- [daily:${note.day}] ${cleanLine(note.text).slice(0, 400)}`);
  const end = start + factLines.length;
  return [
    `User facts ${factLines.length ? `${start + 1}-${end}` : "none"} of ${facts.length}:`,
    factLines.join("\n") || "- none",
    end < facts.length ? `More facts remain: call list again with offset ${end} before applying.` : "",
    start === 0 ? `DM notes from the last ${AUDIT_NOTE_DAYS} days, newest first (read-only evidence):` : "",
    start === 0 ? noteLines.join("\n") || "- none" : "",
  ].filter(Boolean).join("\n");
}

function auditText(text) {
  const value = cleanLine(text);
  if (!value || value.length > 2_000 || containsSensitive(value)) {
    throw Object.assign(new Error("Fact text must be nonempty, at most 2,000 characters, and free of secrets."), { status: 400 });
  }
  return value;
}

export function applyMemoryAudit(userId, changes, run = newAuditRun()) {
  if (!Array.isArray(changes) || changes.length > AUDIT_CHANGE_LIMIT) {
    throw Object.assign(new Error(`changes must be an array of at most ${AUDIT_CHANGE_LIMIT} items.`), { status: 400 });
  }
  const db = database();
  const touched = new Map();
  const counts = db.transaction(() => {
    const batch = { added: 0, merged: 0, dropped: 0, fixed: 0, flagged: 0, skipped: 0 };
    const missing = [];
    const auditSeen = (id) => touched.get(id) ?? run.touched.get(id) ?? -Infinity;
    const restated = (entry) => entry.lastSeen > run.since && entry.lastSeen > auditSeen(entry.id);
    const mark = (id) => touched.set(id, db.fact("user", userId, id).lastSeen);
    const related = (text) => {
      const key = singleValueKey(text);
      const same = db.sameFacts("user", userId, text);
      return key ? [...same, ...db.list("user", userId).filter((entry) => key.test(normalize(entry.text)))] : same;
    };
    for (const change of changes) {
      if (!AUDIT_OPS.has(change?.op)) throw Object.assign(new Error(`Unknown op ${JSON.stringify(change?.op)}.`), { status: 400 });
      if (change.op === "add") {
        const text = auditText(change.text);
        if (related(text).some(restated)) {
          batch.skipped += 1;
        } else if (!db.sameFacts("user", userId, text).length) {
          mark(storeFact("user", userId, text).entry.id);
          batch.added += 1;
        }
        continue;
      }
      if (change.op === "merge" && (!Array.isArray(change.ids) || new Set(change.ids).size < 2)) {
        throw Object.assign(new Error("merge needs at least two distinct ids."), { status: 400 });
      }
      const ids = (change.op === "merge" ? [...new Set(change.ids)] : [change.id]).map((id) => String(id ?? ""));
      const entries = ids.map((id) => db.fact("user", userId, id));
      const text = ["merge", "fix"].includes(change.op) ? auditText(change.text) : null;
      if (entries.includes(null)) {
        missing.push(...ids.filter((_, index) => !entries[index]));
        batch.skipped += 1;
        continue;
      }
      if ([...entries, ...(text ? related(text) : [])].some(restated)) {
        batch.skipped += 1;
        continue;
      }
      if (change.op === "merge") {
        const uncertain = [...entries, ...related(text)].some((entry) => !entry.confirmed);
        const [kept, ...rest] = entries.sort((a, b) => a.ts - b.ts);
        for (const entry of rest) db.forget("user", userId, entry.id);
        if (rest.some((entry) => entry.pinned === true)) db.pin("user", userId, kept.id, true);
        const merged = reviseMemory("user", userId, kept.id, text);
        if (uncertain) db.setConfirmed("user", userId, merged.id, false);
        mark(merged.id);
        batch.merged += rest.length;
      } else if (change.op === "drop") {
        const [entry] = entries;
        if (entry.pinned === true) throw Object.assign(new Error(`Fact ${entry.id} is pinned by the user; flag it instead of dropping it.`), { status: 400 });
        db.forget("user", userId, entry.id);
        batch.dropped += 1;
      } else if (change.op === "fix") {
        mark(reviseMemory("user", userId, entries[0].id, text).id);
        batch.fixed += 1;
      } else {
        db.setConfirmed("user", userId, entries[0].id, false);
        batch.flagged += 1;
      }
    }
    const totals = Object.fromEntries(Object.entries(run.totals).map(([name, value]) => [name, value + batch[name]]));
    db.setMeta(auditKey(userId), JSON.stringify({ at: Date.now(), ...totals }));
    return { ...batch, missing };
  });
  for (const [id, seen] of touched) run.touched.set(id, seen);
  for (const name of Object.keys(run.totals)) run.totals[name] += counts[name];
  return counts;
}

export function memoryAuditStatus(userId) {
  const db = database();
  const facts = list("user", userId);
  let last = null;
  try { last = JSON.parse(db.meta(auditKey(userId)) || "null"); } catch {}
  return { facts: facts.length, unconfirmed: facts.filter((entry) => !entry.confirmed).length, last };
}

const SENSITIVE_RE = /\b(?:api[_ -]?key|password|passwd|secret|access[_ -]?token|auth(?:orization)?[_ -]?token|bearer)\b\s*(?:is|=|:)?\s*[^\s,;]+|\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/gi;

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
    const facts = [];
    for (const fact of extractDurableFacts ? extractFacts(userText) : []) {
      if (storeFact("user", userId, fact).created) facts.push(fact);
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
  config.userSettings[userId] = { ...config.userSettings[userId], ...partial };
  save(CONFIG_FILE, config);
  return true;
}
