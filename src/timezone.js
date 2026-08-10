const DEFAULT_TIME_ZONE = "UTC";

export function normalizeTimeZone(value) {
  const timeZone = String(value || "").trim();
  if (!timeZone) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return timeZone;
  } catch {
    throw new Error("Timezone must be a valid IANA timezone, such as `America/New_York`.");
  }
}

/** Chrono-style UTC offset in minutes (EDT => -240). */
export function getTimeZoneOffsetMinutes(timeZone, date = new Date()) {
  const normalized = normalizeTimeZone(timeZone);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: normalized,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((asUtc - date.getTime()) / 60_000);
}

export function localDateParts(timestamp, timeZone = DEFAULT_TIME_ZONE) {
  const normalized = normalizeTimeZone(timeZone);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: normalized,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(timestamp))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: weekdayMap[parts.weekday] ?? 0,
  };
}

/**
 * Convert a wall-clock local datetime in an IANA zone to a UTC epoch ms.
 * Iterates so the offset used matches the target date (DST-safe), not the
 * reference instant's offset.
 */
export function zonedWallTimeToUtc(
  { year, month, day, hour = 0, minute = 0, second = 0 },
  timeZone = DEFAULT_TIME_ZONE,
) {
  const zone = normalizeTimeZone(timeZone);
  const desired = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = desired;
  for (let i = 0; i < 4; i++) {
    const parts = localDateParts(guess, zone);
    const asUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const delta = desired - asUtc;
    if (delta === 0) break;
    guess += delta;
  }
  return guess;
}

export function formatInTimeZone(timestamp, timeZone = DEFAULT_TIME_ZONE) {
  if (!Number.isFinite(timestamp)) return null;
  const normalized = normalizeTimeZone(timeZone);
  const formatted = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: normalized,
  }).format(new Date(timestamp));
  return `${formatted} (${normalized})`;
}

export function formatMessageTimestamp(timestamp, timeZone = DEFAULT_TIME_ZONE) {
  if (!Number.isFinite(timestamp)) return null;
  const normalized = normalizeTimeZone(timeZone);
  const formatted = new Intl.DateTimeFormat("en-US", {
    dateStyle: "full",
    timeStyle: "long",
    timeZone: normalized,
  }).format(new Date(timestamp));
  return `${formatted} (${normalized})`;
}

export { DEFAULT_TIME_ZONE };
