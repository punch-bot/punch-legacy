import test from "node:test";
import assert from "node:assert/strict";
import {
  formatInTimeZone,
  formatMessageTimestamp,
  getTimeZoneOffsetMinutes,
  localDateParts,
  normalizeTimeZone,
} from "../src/timezone.js";

test("normalizes valid IANA timezones", () => {
  assert.equal(normalizeTimeZone("America/New_York"), "America/New_York");
});

test("rejects invalid timezones", () => {
  assert.throws(() => normalizeTimeZone("not/a-timezone"), /valid IANA timezone/);
});

test("formats the supplied timestamp in the supplied timezone", () => {
  assert.equal(
    formatMessageTimestamp(Date.parse("2026-08-08T19:42:00.000Z"), "America/New_York"),
    "Saturday, August 8, 2026 at 3:42:00 PM EDT (America/New_York)",
  );
});

test("does not substitute the current time for a missing timestamp", () => {
  assert.equal(formatMessageTimestamp(undefined, "UTC"), null);
});

test("computes chrono-compatible offsets for IANA zones", () => {
  assert.equal(getTimeZoneOffsetMinutes("America/New_York", new Date("2026-08-10T15:00:00.000Z")), -240);
  assert.equal(getTimeZoneOffsetMinutes("UTC", new Date("2026-08-10T15:00:00.000Z")), 0);
});

test("localDateParts reads wall-clock fields in the user zone", () => {
  const parts = localDateParts(Date.parse("2026-08-11T13:00:00.000Z"), "America/New_York");
  assert.equal(parts.hour, 9);
  assert.equal(parts.minute, 0);
  assert.equal(parts.weekday, 2); // Tuesday
});

test("formatInTimeZone includes the zone label", () => {
  assert.match(formatInTimeZone(Date.parse("2026-08-11T13:00:00.000Z"), "America/New_York"), /America\/New_York/);
});
