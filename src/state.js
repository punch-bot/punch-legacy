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

let state = load(STATE_FILE, { activities: [], heartbeatSessions: {} });
let activitySeq = 0;

function newActivityId() {
  activitySeq += 1;
  return (Date.now().toString(36) + activitySeq.toString(36)).slice(-8);
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
  };
  state.activities.push(record);
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
