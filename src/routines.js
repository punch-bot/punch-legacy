import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import * as chrono from "chrono-node";
import cronParser from "cron-parser";
import { DEFAULT_TIME_ZONE, formatInTimeZone, getTimeZoneOffsetMinutes, localDateParts, normalizeTimeZone, zonedWallTimeToUtc } from "./timezone.js";

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), "data");
const ROUTINES_FILE = join(DATA_DIR, "routines.json");
const HISTORY_FILE = join(DATA_DIR, "routine-history.json");
const MAX_HISTORY_PER_ROUTINE = 30;
const MAX_ATTEMPTS = Math.max(1, Number(process.env.PUNCH_ROUTINE_MAX_ATTEMPTS) || 5);
const BASE_RETRY_MS = Math.max(1_000, Number(process.env.PUNCH_ROUTINE_RETRY_BASE_MS) || 30_000);
const IDLE_POLL_MS = 60_000;

let seq = 0;
let timer = null;
let onFireCallback = null;
let rescheduleCallback = null;
let runDuePending = false;
let routines = load(ROUTINES_FILE, []);
let history = load(HISTORY_FILE, []);

function load(file, fallback) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function atomicWrite(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporary, file);
}

function saveRoutines() {
  atomicWrite(ROUTINES_FILE, routines);
}

function saveHistory() {
  atomicWrite(HISTORY_FILE, history);
}

function save() {
  saveRoutines();
  saveHistory();
}

function newId() {
  seq += 1;
  return (Date.now().toString(36) + seq.toString(36)).slice(-8);
}

function normalizeRoutine(routine) {
  if (!routine || typeof routine !== "object") return null;
  const now = Date.now();
  const next = Number(routine.nextRunAt);
  if (!routine.id || !routine.userId || !routine.type || !routine.schedule || !Number.isFinite(next)) return null;
  return {
    ...routine,
    guildId: routine.guildId || null,
    enabled: routine.enabled !== false,
    createdAt: Number.isFinite(routine.createdAt) ? routine.createdAt : now,
    lastRunAt: Number.isFinite(routine.lastRunAt) ? routine.lastRunAt : null,
    attempts: Number.isInteger(routine.attempts) && routine.attempts >= 0 ? routine.attempts : 0,
    state: ["queued", "running", "succeeded", "failed"].includes(routine.state) ? routine.state : "queued",
    activeHours: normalizeActiveHours(routine.activeHours),
    timezone: validTimezone(routine.timezone) ? routine.timezone : null,
    isolatedSession: routine.isolatedSession === true,
  };
}

function validTimezone(value) {
  if (!value || typeof value !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function normalizeActiveHours(value) {
  if (!value || typeof value !== "object") return null;
  const start = Number(value.start);
  const end = Number(value.end);
  const timezone = validTimezone(value.timezone) ? value.timezone : null;
  if (!Number.isInteger(start) || start < 0 || start > 23 || !Number.isInteger(end) || end < 0 || end > 23 || !timezone) return null;
  return { start, end, timezone };
}

routines = routines.map(normalizeRoutine).filter(Boolean);
for (const routine of routines) {
  // Never replay unknown in-flight side effects after a bot restart. Execution may
  // have completed before persistence; preserve at-most-once behavior.
  if (routine.state === "running") {
    routine.state = "failed";
    routine.enabled = false;
    routine.lastError = "Interrupted by bot restart; paused to avoid duplicate execution.";
    history.push({ id: newId(), routineId: routine.id, userId: routine.userId, status: "failed", attempt: routine.attempts || 1, startedAt: routine.startedAt || Date.now(), finishedAt: Date.now(), error: routine.lastError, recovered: true });
  }
}
history = history.filter((entry) => entry && entry.routineId && entry.userId).slice(-2_000);
if (existsSync(ROUTINES_FILE)) save();

function parseShorthand(when) {
  const match = when.trim().match(/^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i);
  if (!match) return null;
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  return Date.now() + (unit.startsWith("m") ? n * 60_000 : unit.startsWith("h") ? n * 3_600_000 : n * 86_400_000);
}

function chronoReference(refDate = new Date(), timeZone = null) {
  const instant = refDate instanceof Date ? refDate : new Date(refDate);
  if (!timeZone) return instant;
  const normalized = normalizeTimeZone(timeZone);
  return {
    instant,
    // chrono-node accepts numeric UTC offsets, not IANA names. This offset is
    // only used to resolve relative phrases; parseTime re-resolves the target
    // wall clock with the offset that applies on that local date (DST-safe).
    timezone: getTimeZoneOffsetMinutes(normalized, instant),
  };
}

export function parseTime(when, refDate = new Date(), timeZone = null) {
  const trimmed = String(when || "").trim();
  const shorthand = parseShorthand(trimmed);
  if (shorthand) return shorthand;
  const zone = timeZone ? normalizeTimeZone(timeZone) : null;
  if (!zone) {
    const parsed = chrono.parseDate(trimmed, refDate, { forwardDate: true });
    if (parsed) return parsed.getTime();
  } else {
    const results = chrono.parse(trimmed, chronoReference(refDate, zone), { forwardDate: true });
    const start = results[0]?.start;
    if (start) {
      return zonedWallTimeToUtc(
        {
          year: start.get("year"),
          month: start.get("month"),
          day: start.get("day"),
          hour: start.get("hour") ?? 0,
          minute: start.get("minute") ?? 0,
          second: start.get("second") ?? 0,
        },
        zone,
      );
    }
  }
  const iso = Date.parse(trimmed);
  if (!Number.isNaN(iso)) return iso;
  throw new Error(`Could not parse time: "${when}"`);
}

export function parseRecurrence(when, recurrence, timeZone = null) {
  const lower = String(recurrence || "once").toLowerCase().trim();
  const zone = timeZone ? normalizeTimeZone(timeZone) : null;
  if (lower === "once") return { kind: "once", at: parseTime(when, new Date(), zone) };
  if (lower === "daily" || lower === "weekly") {
    const at = parseTime(when, new Date(), zone);
    const parts = localDateParts(at, zone || DEFAULT_TIME_ZONE);
    return {
      kind: "cron",
      cron: lower === "daily"
        ? `${parts.minute} ${parts.hour} * * *`
        : `${parts.minute} ${parts.hour} * * ${parts.weekday}`,
    };
  }
  const interval = lower.match(/^every\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i);
  if (interval) return parseEveryInterval(`${interval[1]}${interval[2]}`);
  if (/^[\d*,/-]+\s+[\d*,/-]+\s+[\d*,/-]+\s+[\d*,/-]+\s+[\d*,/-]+$/.test(lower)) return { kind: "cron", cron: lower };
  throw new Error(`Unknown recurrence: "${recurrence}"`);
}

export function parseDailyTime(timeStr, timeZone = null) {
  const zone = timeZone ? normalizeTimeZone(timeZone) : null;
  const at = parseTime(timeStr, new Date(), zone);
  const parts = localDateParts(at, zone || DEFAULT_TIME_ZONE);
  return { kind: "cron", cron: `${parts.minute} ${parts.hour} * * *` };
}

export function parseEveryInterval(intervalStr) {
  const match = String(intervalStr).trim().match(/^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i);
  if (!match) throw new Error(`Could not parse interval: "${intervalStr}"`);
  const n = Number(match[1]);
  return { kind: "interval", everyMs: match[2].toLowerCase().startsWith("m") ? n * 60_000 : n * 3_600_000 };
}

function localHour(at, timezone) {
  const hour = new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: timezone }).formatToParts(new Date(at)).find((part) => part.type === "hour")?.value;
  return Number(hour);
}

function inActiveHours(activeHours, at) {
  if (!activeHours) return true;
  const hour = localHour(at, activeHours.timezone);
  if (activeHours.start === activeHours.end) return true;
  return activeHours.start < activeHours.end ? hour >= activeHours.start && hour < activeHours.end : hour >= activeHours.start || hour < activeHours.end;
}

function nextActiveTime(activeHours, from) {
  if (!activeHours || inActiveHours(activeHours, from)) return from;
  // Minute stepping avoids host timezone/DST math errors; bounded to two days.
  let candidate = from - (from % 60_000) + 60_000;
  const limit = candidate + 48 * 3_600_000;
  while (candidate <= limit) {
    if (inActiveHours(activeHours, candidate)) return candidate;
    candidate += 60_000;
  }
  return candidate;
}

export function computeNextRun(schedule, afterMs = Date.now(), timezone = null, activeHours = null) {
  let next;
  if (schedule.kind === "once") next = schedule.at > afterMs ? schedule.at : null;
  else if (schedule.kind === "interval") next = afterMs + schedule.everyMs;
  else if (schedule.kind === "cron") {
    try {
      const parser = cronParser.CronExpressionParser || cronParser;
      next = parser.parse(schedule.cron, { currentDate: new Date(afterMs), ...(timezone ? { tz: timezone } : {}) }).next().getTime();
    } catch (error) {
      throw new Error(`Invalid cron expression "${schedule.cron}": ${error.message}`);
    }
  } else next = null;
  return next === null ? null : nextActiveTime(activeHours, next);
}

export function addRoutine({ userId, channelId, guildId, type, payload, schedule, timezone = null, activeHours = null, isolatedSession = false }) {
  if (!new Set(["message", "llm", "heartbeat"]).has(type)) throw new Error("Invalid routine type");
  const normalizedHours = normalizeActiveHours(activeHours);
  // Prefer explicit timezone, then active-hours zone, then UTC for cron schedules so
  // "9am" means the user's 9am rather than the bot host's local clock.
  const normalizedTimezone = validTimezone(timezone)
    ? timezone
    : normalizedHours?.timezone || (schedule?.kind === "cron" ? DEFAULT_TIME_ZONE : null);
  const nextRunAt = computeNextRun(schedule, Date.now(), normalizedTimezone, normalizedHours);
  if (nextRunAt === null) throw new Error("Scheduled time is in the past");
  const routine = { id: newId(), userId: String(userId), channelId: channelId || null, guildId: guildId || null, type, payload: String(payload), schedule, timezone: normalizedTimezone, activeHours: normalizedHours, isolatedSession: isolatedSession === true, nextRunAt, lastRunAt: null, enabled: true, state: "queued", attempts: 0, createdAt: Date.now(), lastError: null };
  routines.push(routine);
  saveRoutines();
  rescheduleCallback?.();
  return routine;
}

export function removeRoutine(id, userId) {
  const index = routines.findIndex((routine) => routine.id === id && routine.userId === userId);
  if (index < 0) return false;
  routines.splice(index, 1);
  saveRoutines();
  rescheduleCallback?.();
  return true;
}

export function setRoutineEnabled(id, userId, enabled) {
  const routine = routines.find((entry) => entry.id === id && entry.userId === userId);
  if (!routine) return null;
  routine.enabled = Boolean(enabled);
  routine.state = routine.enabled ? "queued" : routine.state;
  routine.lastError = routine.enabled ? null : routine.lastError;
  if (routine.enabled && routine.schedule.kind !== "once") routine.nextRunAt = computeNextRun(routine.schedule, Date.now(), routine.timezone, routine.activeHours);
  saveRoutines();
  rescheduleCallback?.();
  return routine;
}

export const pauseRoutine = (id, userId) => setRoutineEnabled(id, userId, false);
export const resumeRoutine = (id, userId) => setRoutineEnabled(id, userId, true);
export const listRoutines = (userId) => routines.filter((routine) => routine.userId === userId);
export const listAll = () => routines;
export const getRoutine = (id) => routines.find((routine) => routine.id === id) || null;
export const listHistory = (userId, routineId = null, limit = 20) => history.filter((entry) => entry.userId === userId && (!routineId || entry.routineId === routineId)).slice(-Math.max(1, Math.min(100, limit))).reverse();

function appendHistory(entry) {
  history.push(entry);
  if (history.length > 2_000) history = history.slice(-2_000);
  saveHistory();
}

function markStarted(routine) {
  routine.state = "running";
  routine.attempts += 1;
  routine.startedAt = Date.now();
  routine.lastError = null;
  saveRoutines();
  return { id: newId(), routineId: routine.id, userId: routine.userId, status: "running", attempt: routine.attempts, startedAt: routine.startedAt, finishedAt: null, error: null };
}

function completeRoutine(routine, execution) {
  const finishedAt = Date.now();
  execution.status = "succeeded";
  execution.finishedAt = finishedAt;
  appendHistory(execution);
  const index = routines.findIndex((entry) => entry.id === routine.id);
  if (routine.schedule.kind === "once") {
    if (index >= 0) routines.splice(index, 1);
  } else {
    routine.state = "succeeded";
    routine.lastRunAt = finishedAt;
    routine.attempts = 0;
    routine.nextRunAt = computeNextRun(routine.schedule, finishedAt, routine.timezone, routine.activeHours);
    routine.state = "queued";
  }
  saveRoutines();
}

function failRoutine(routine, execution, error) {
  const finishedAt = Date.now();
  const message = String(error?.message || error || "Routine failed").slice(0, 2_000);
  execution.status = "failed";
  execution.finishedAt = finishedAt;
  execution.error = message;
  appendHistory(execution);
  routine.lastError = message;
  if (routine.attempts >= MAX_ATTEMPTS) {
    routine.state = "failed";
    routine.enabled = false;
  } else {
    routine.state = "queued";
    const retryMs = Math.min(3_600_000, BASE_RETRY_MS * 2 ** Math.max(0, routine.attempts - 1));
    routine.nextRunAt = nextActiveTime(routine.activeHours, finishedAt + retryMs);
  }
  saveRoutines();
}

// Compatibility for legacy caller. Durable scheduler uses markStarted/completeRoutine.
export function markFired(routine) {
  const current = getRoutine(routine.id);
  if (!current) return;
  const execution = { id: newId(), routineId: current.id, userId: current.userId, status: "running", attempt: current.attempts || 1, startedAt: current.startedAt || Date.now(), finishedAt: null, error: null };
  completeRoutine(current, execution);
  rescheduleCallback?.();
}

export function formatRoutine(routine) {
  const label = routine.type === "heartbeat" ? "heartbeat" : routine.type === "llm" ? "auto" : "remind";
  const schedule = routine.schedule;
  const zone = routine.timezone || DEFAULT_TIME_ZONE;
  const next = formatInTimeZone(routine.nextRunAt, zone);
  const scheduleLabel = schedule.kind === "once"
    ? `once @ ${formatInTimeZone(schedule.at, zone) || new Date(schedule.at).toISOString()}`
    : schedule.kind === "cron"
      ? `cron \`${schedule.cron}\` (${zone})${next ? ` next ${next}` : ""}`
      : `every ${Math.round(schedule.everyMs / 60_000)}m${next ? ` next ${next}` : ""}`;
  const preview = routine.payload.length > 60 ? `${routine.payload.slice(0, 57)}...` : routine.payload;
  const state = routine.enabled ? "" : ` (${routine.state === "failed" ? "failed" : "paused"})`;
  return `\`${routine.id}\` [${label}] ${scheduleLabel}${state} — ${preview}`;
}

function clearTimer() {
  if (timer) clearTimeout(timer);
  timer = null;
}

function scheduleNext() {
  clearTimer();
  if (runDuePending) return;
  runDuePending = true;
  runDue().catch((error) => console.error("[routines] scheduler failure:", error.message)).finally(() => { runDuePending = false; });
}

async function runDue() {
  const now = Date.now();
  const due = routines.filter((routine) => routine.enabled && routine.state === "queued" && routine.nextRunAt <= now);
  for (const routine of due) {
    const execution = markStarted(routine);
    try {
      await onFireCallback?.(routine);
      completeRoutine(routine, execution);
    } catch (error) {
      console.error(`[routines] fire ${routine.id} failed:`, error.message);
      failRoutine(routine, execution, error);
    }
  }
  const upcoming = routines.filter((routine) => routine.enabled && routine.state === "queued" && routine.nextRunAt > Date.now()).sort((a, b) => a.nextRunAt - b.nextRunAt);
  const delay = upcoming.length ? Math.min(2_147_483_647, Math.max(0, upcoming[0].nextRunAt - Date.now())) : IDLE_POLL_MS;
  timer = setTimeout(scheduleNext, delay);
}

export function startScheduler(onFire) {
  onFireCallback = onFire;
  rescheduleCallback = scheduleNext;
  scheduleNext();
  console.log(`[routines] durable scheduler started (${routines.filter((routine) => routine.enabled).length} active)`);
}

export function stopScheduler() {
  clearTimer();
  onFireCallback = null;
  rescheduleCallback = null;
}
