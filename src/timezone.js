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
