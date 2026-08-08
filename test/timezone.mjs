import test from "node:test";
import assert from "node:assert/strict";
import { formatMessageTimestamp, normalizeTimeZone } from "../src/timezone.js";

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
