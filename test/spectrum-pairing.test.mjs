import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "punch-pair-"));
process.env.DATA_DIR = dir;

const {
  issuePairingCode,
  completePairing,
  mergeUserMaps,
  getPairedUserMap,
  formatPairingMessage,
  _resetPairingStoreForTests,
} = await import("../src/spectrum/pairing.js");

test.after(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

test("issuePairingCode returns 9-digit code and stable message", () => {
  _resetPairingStoreForTests();
  const first = issuePairingCode("+1 (415) 555-0100");
  assert.match(first.code, /^\d{9}$/);
  assert.equal(first.message, formatPairingMessage(first.code));
  assert.match(first.message, /Run \/pair in discord/);
  assert.equal(first.address, "+14155550100");

  const second = issuePairingCode("+14155550100");
  assert.equal(second.code, first.code);
  assert.equal(second.created, false);
});

test("completePairing binds address to Discord userId", () => {
  _resetPairingStoreForTests();
  const issued = issuePairingCode("user@icloud.com");
  const done = completePairing(issued.code, "999888777666");
  assert.equal(done.ok, true);
  assert.equal(done.address, "user@icloud.com");
  assert.equal(getPairedUserMap()["user@icloud.com"], "999888777666");
  assert.equal(mergeUserMaps({})["user@icloud.com"], "999888777666");
});

test("completePairing rejects bad or expired codes", () => {
  _resetPairingStoreForTests();
  assert.equal(completePairing("123", "1").ok, false);
  assert.equal(completePairing("123456789", "1").ok, false);
});

test("env SPECTRUM_USER_MAP wins over durable pairs on conflict", () => {
  _resetPairingStoreForTests();
  const issued = issuePairingCode("+15550001111");
  completePairing(issued.code, "from-pair");
  const merged = mergeUserMaps({ "+15550001111": "from-env" });
  assert.equal(merged["+15550001111"], "from-env");
});
