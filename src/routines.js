// Routine parsing stays local (pure, sync, used heavily by slash-command UX).
// All durable state and scheduling is owned by the supervisor service.
import * as chrono from "chrono-node";
import cronParser from "cron-parser";
import {
  DEFAULT_TIME_ZONE,
  formatInTimeZone,
  getTimeZoneOffsetMinutes,
  localDateParts,
  normalizeTimeZone,
  zonedWallTimeToUtc,
} from "./timezone.js";
import { routines as supervisorRoutines } from "./supervisor.js";

export { DEFAULT_TIME_ZONE, formatInTimeZone };

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
  return { instant, timezone: getTimeZoneOffsetMinutes(normalized, instant) };
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
      if (start.isCertain("timezoneOffset")) return start.date().getTime();
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
      cron: lower === "daily" ? `${parts.minute} ${parts.hour} * * *` : `${parts.minute} ${parts.hour} * * ${parts.weekday}`,
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

export function computeNextRun(schedule, afterMs = Date.now(), timezone = null, activeHours = null) {
  let next;
  if (schedule.kind === "once") next = schedule.at > afterMs ? schedule.at : null;
  else if (schedule.kind === "interval") next = afterMs + schedule.everyMs;
  else if (schedule.kind === "cron") {
    const parser = cronParser.CronExpressionParser || cronParser;
    next = parser.parse(schedule.cron, { currentDate: new Date(afterMs), ...(timezone ? { tz: timezone } : {}) }).next().getTime();
  } else next = null;
  if (next === null || !activeHours) return next;
  let candidate = next;
  const inHours = (at) => {
    const start = activeHours.start;
    const end = activeHours.end;
    const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: activeHours.timezone }).formatToParts(new Date(at)).find((p) => p.type === "hour")?.value);
    if (start === end) return true;
    return start < end ? hour >= start && hour < end : hour >= start || hour < end;
  };
  while (!inHours(candidate)) candidate += 60_000;
  return candidate;
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

// Durable CRUD is delegated to the supervisor.
export async function addRoutine(opts) {
  const data = await supervisorRoutines.create(opts);
  return data.routine;
}

export async function listRoutines(userId) {
  const data = await supervisorRoutines.list(userId);
  return data.routines;
}

export async function listHistory(userId, routineId = null, limit = 20) {
  if (routineId) {
    const data = await supervisorRoutines.history(routineId, userId, limit);
    return data.history;
  }
  const data = await supervisorRoutines.list(userId);
  return data.routines;
}

export async function removeRoutine(id, userId) {
  const data = await supervisorRoutines.remove(id, userId);
  return data.ok;
}

export async function setRoutineEnabled(id, userId, enabled) {
  const data = enabled ? await supervisorRoutines.resume(id, userId) : await supervisorRoutines.pause(id, userId);
  return data.routine;
}

export const pauseRoutine = (id, userId) => setRoutineEnabled(id, userId, false);
export const resumeRoutine = (id, userId) => setRoutineEnabled(id, userId, true);
