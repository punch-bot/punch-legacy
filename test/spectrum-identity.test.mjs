import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeAddressKey,
  senderLookupKeys,
  resolvePunchUserId,
} from "../src/spectrum/identity.js";

test("normalizeAddressKey keeps E.164 and lowercases email", () => {
  assert.equal(normalizeAddressKey("+1 (555) 123-4567"), "+15551234567");
  assert.equal(normalizeAddressKey("User@Example.COM"), "user@example.com");
});

test("senderLookupKeys includes id and address variants", () => {
  const keys = senderLookupKeys({ id: "+1-555-0001", address: "a@b.com" });
  assert.ok(keys.includes("+1-555-0001"));
  assert.ok(keys.includes("a@b.com"));
  assert.ok(keys.includes("a@b.com".toLowerCase()));
});

test("resolvePunchUserId uses user map before default", () => {
  const uid = resolvePunchUserId(
    { address: "+15551234567" },
    {
      defaultUserId: "default",
      userMap: { "+15551234567": "mapped" },
    },
  );
  assert.equal(uid, "mapped");
});

test("resolvePunchUserId falls back to defaultUserId", () => {
  const uid = resolvePunchUserId(
    { id: "unknown" },
    { defaultUserId: "default", userMap: {} },
  );
  assert.equal(uid, "default");
});

test("resolvePunchUserId matches normalized map keys", () => {
  const uid = resolvePunchUserId(
    { address: "+1 (555) 999-0000" },
    {
      defaultUserId: "default",
      userMap: { "+15559990000": "mapped" },
    },
  );
  assert.equal(uid, "mapped");
});

test("resolvePunchUserId returns null without default or map hit", () => {
  const uid = resolvePunchUserId({ id: "x" }, { userMap: {} });
  assert.equal(uid, null);
});
