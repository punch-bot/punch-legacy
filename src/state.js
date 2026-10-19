import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), "data");
const STATE_FILE = join(DATA_DIR, "state.json");

function load(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function save() {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

const MAX_ACTIVITIES = 10_000;

let state = load(STATE_FILE, { activities: [], heartbeatSessions: {} });
let activitySeq = 0;

const PERIOD_MS = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
  year: 365 * 24 * 60 * 60 * 1000,
};

function newActivityId() {
  activitySeq += 1;
  return (Date.now().toString(36) + activitySeq.toString(36)).slice(-8);
}

function normalizeTokens(tokens) {
  if (!tokens || typeof tokens !== "object") return null;
  const input = Number(tokens.input) || 0;
  const output = Number(tokens.output) || 0;
  const reasoning = Number(tokens.reasoning) || 0;
  const cacheRead = Number(tokens.cacheRead ?? tokens.cache?.read) || 0;
  const cacheWrite = Number(tokens.cacheWrite ?? tokens.cache?.write) || 0;
  const total = input + output + reasoning + cacheRead + cacheWrite;
  if (!total) return null;
  return { input, output, reasoning, cacheRead, cacheWrite, total };
}

export function recordActivity(entry) {
  const record = {
    id: newActivityId(),
    ts: Date.now(),
    userId: entry.userId,
    channelId: entry.channelId || null,
    type: entry.type || "reactive",
    prompt: (entry.prompt || "").slice(0, 500),
    response: (entry.response || "").slice(0, 2000),
    sessionId: entry.sessionId || null,
    status: entry.status || "success",
    duration: entry.duration || 0,
    routineId: entry.routineId || null,
    cost: Number(entry.cost) || 0,
    tokens: normalizeTokens(entry.tokens),
    messages: Math.max(1, Number(entry.messages) || 1),
  };
  state.activities.push(record);
  if (state.activities.length > MAX_ACTIVITIES) {
    state.activities = state.activities.slice(-MAX_ACTIVITIES);
  }
  save();
  return record;
}

export function getActivities(userId, { type, limit = 20 } = {}) {
  let list = state.activities.filter((a) => a.userId === userId);
  if (type) list = list.filter((a) => a.type === type);
  return list.slice(-limit).reverse();
}

export function getActivityStats(userId) {
  const list = state.activities.filter((a) => a.userId === userId);
  const byType = {};
  for (const a of list) {
    byType[a.type] = (byType[a.type] || 0) + 1;
  }
  const last = list[list.length - 1];
  return {
    total: list.length,
    byType,
    lastActivityTs: last?.ts || null,
  };
}

export function periodStart(period, now = Date.now()) {
  const ms = PERIOD_MS[period];
  if (!ms) throw new Error(`Unknown statistics period: ${period}`);
  return now - ms;
}

export function getUsageStatistics(userId, period = "week", now = Date.now()) {
  const since = periodStart(period, now);
  const list = state.activities.filter((a) => a.userId === userId && a.ts >= since);

  let userMessages = 0;
  let automations = 0;
  let successfulTurns = 0;
  let failedTurns = 0;
  let totalDuration = 0;
  let durationCount = 0;
  let totalCost = 0;
  const tokenTotals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const byType = {};

  for (const activity of list) {
    byType[activity.type] = (byType[activity.type] || 0) + 1;
    if (activity.status === "success") successfulTurns += 1;
    else failedTurns += 1;

    if (activity.type === "heartbeat" || activity.routineId) {
      automations += 1;
    } else if (activity.type === "reactive") {
      userMessages += activity.messages || 1;
    }

    if (activity.duration > 0) {
      totalDuration += activity.duration;
      durationCount += 1;
    }

    totalCost += Number(activity.cost) || 0;
    if (activity.tokens) {
      tokenTotals.input += activity.tokens.input || 0;
      tokenTotals.output += activity.tokens.output || 0;
      tokenTotals.reasoning += activity.tokens.reasoning || 0;
      tokenTotals.cacheRead += activity.tokens.cacheRead || 0;
      tokenTotals.cacheWrite += activity.tokens.cacheWrite || 0;
      tokenTotals.total += activity.tokens.total || 0;
    }
  }

  const last = list[list.length - 1];
  return {
    period,
    since,
    until: now,
    totalTurns: list.length,
    userMessages,
    automations,
    successfulTurns,
    failedTurns,
    byType,
    avgDurationMs: durationCount ? Math.round(totalDuration / durationCount) : 0,
    totalCost,
    tokens: tokenTotals,
    lastActivityTs: last?.ts || null,
  };
}

export function getHeartbeatSession(userId) {
  return state.heartbeatSessions[userId] || null;
}

export function setHeartbeatSession(userId, sessionId) {
  if (sessionId) {
    state.heartbeatSessions[userId] = sessionId;
  } else {
    delete state.heartbeatSessions[userId];
  }
  save();
}

export function getAllActivities({ type, limit = 50 } = {}) {
  let list = [...state.activities];
  if (type) list = list.filter((a) => a.type === type);
  return list.slice(-limit).reverse();
}
