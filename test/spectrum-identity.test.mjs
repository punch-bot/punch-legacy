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

test("normalizeAddressKey adds leading + to bare digit phones", () => {
  assert.equal(normalizeAddressKey("15551234567"), "+15551234567");
  assert.equal(normalizeAddressKey("1 (555) 123-4567"), "+15551234567");
  assert.equal(normalizeAddressKey("+15551234567"), "+15551234567");
});

test("resolvePunchUserId matches bare digits to E.164 map keys", () => {
  const uid = resolvePunchUserId(
    { address: "15551234567" },
    { userMap: { "+15551234567": "mapped" } },
  );
  assert.equal(uid, "mapped");
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
    null,
    { allowDefault: true },
  );
  assert.equal(uid, "mapped");
});

test("resolvePunchUserId rejects unknown senders unless allowDefault", () => {
  assert.equal(
    resolvePunchUserId({ id: "unknown" }, { defaultUserId: "default", userMap: {} }),
    null,
  );
  assert.equal(
    resolvePunchUserId(
      { id: "unknown" },
      { defaultUserId: "default", userMap: {} },
      null,
      { allowDefault: true },
    ),
    "default",
  );
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

test("resolvePunchUserId authorizes mapped iMessage senders without default", () => {
  const uid = resolvePunchUserId(
    { address: "+15550001111" },
    { userMap: { "+15550001111": "punch-user-1" } },
  );
  assert.equal(uid, "punch-user-1");
});
