import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAddressKey, resolvePunchUserId } from "../src/spectrum/identity.js";

test("phone numbers and emails normalise to one key", () => {
  assert.equal(normalizeAddressKey("+1 (555) 123-4567"), "+15551234567");
  assert.equal(normalizeAddressKey("15551234567"), "+15551234567");
  assert.equal(normalizeAddressKey("User@Example.COM"), "user@example.com");
});

test("mapped senders resolve to their Punch user in any number format", () => {
  const config = { userMap: { "+1 555 123 4567": "mapped" } };
  assert.equal(resolvePunchUserId({ address: "15551234567" }, config), "mapped");
  assert.equal(resolvePunchUserId({ id: "+15551234567" }, config), "mapped");
});

test("unknown senders are rejected unless the default user is explicitly allowed", () => {
  const config = { defaultUserId: "owner", userMap: { "+15551234567": "mapped" } };
  assert.equal(resolvePunchUserId({ address: "+15550000000" }, config), null);
  assert.equal(resolvePunchUserId({ address: "+15550000000" }, config, null, { allowDefault: true }), "owner");
  assert.equal(resolvePunchUserId({ address: "+15551234567" }, config, null, { allowDefault: true }), "mapped");
  assert.equal(resolvePunchUserId({}, { userMap: {} }), null);
});
