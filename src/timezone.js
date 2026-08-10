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

function wallFieldsMatch(parts, year, month, day, hour, minute, second) {
  return (
    parts.year === year &&
    parts.month === month &&
    parts.day === day &&
    parts.hour === hour &&
    parts.minute === minute &&
    parts.second === second
  );
}

/**
 * Convert a wall-clock local datetime in an IANA zone to a UTC epoch ms.
 *
 * Policy:
 * - Nonexistent times in a DST spring-forward gap throw.
 * - Ambiguous times in a fall-back overlap resolve to the earlier UTC instant
 *   (still on the pre-transition offset when both exist). Offset deltas are
 *   discovered from the zone (not assumed to be 60 minutes).
 */
export function zonedWallTimeToUtc(
  { year, month, day, hour = 0, minute = 0, second = 0 },
  timeZone = DEFAULT_TIME_ZONE,
) {
  const zone = normalizeTimeZone(timeZone);
  const desired = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsets = new Set();
  for (const hours of [-12, -6, -3, -1, 0, 1, 3, 6, 12]) {
    offsets.add(getTimeZoneOffsetMinutes(zone, new Date(desired + hours * 3_600_000)));
  }
  const matching = [];
  for (const offsetMinutes of offsets) {
    const candidate = desired - offsetMinutes * 60_000;
    if (wallFieldsMatch(localDateParts(candidate, zone), year, month, day, hour, minute, second)) {
      matching.push(candidate);
    }
  }
  if (!matching.length) {
    const pad = (n) => String(n).padStart(2, "0");
    throw new Error(
      `Local time ${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)} does not exist in ${zone}`,
    );
  }
  return Math.min(...matching);
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
