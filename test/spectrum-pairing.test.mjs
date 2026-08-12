import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { Worker } from "node:worker_threads";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, statSync, existsSync } from "node:fs";
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
  formatPairingCompleteMessage,
  listPairedAddressesForUser,
  unpairUser,
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

  const now = 1_700_000_000_000;
  const issued = issuePairingCode("+15550002222", { now, ttlMs: 1_000 });
  const expired = completePairing(issued.code, "1", { now: now + 2_000 });
  assert.equal(expired.ok, false);
  assert.match(expired.error, /expired|Unknown/i);
});

test("formatPairingCompleteMessage includes Discord username", () => {
  assert.equal(
    formatPairingCompleteMessage("ember"),
    "Paired to ember! Send a message again to text your punch!",
  );
});

test("unpairUser removes one or all paired addresses for a user", () => {
  _resetPairingStoreForTests();
  const a = issuePairingCode("+15550001111");
  const b = issuePairingCode("+15550002222");
  completePairing(a.code, "user-1");
  completePairing(b.code, "user-1");
  assert.deepEqual(listPairedAddressesForUser("user-1").sort(), ["+15550001111", "+15550002222"]);

  const one = unpairUser("user-1", "+15550001111");
  assert.equal(one.ok, true);
  assert.deepEqual(one.addresses, ["+15550001111"]);
  assert.deepEqual(listPairedAddressesForUser("user-1"), ["+15550002222"]);

  const all = unpairUser("user-1");
  assert.equal(all.ok, true);
  assert.equal(listPairedAddressesForUser("user-1").length, 0);
});

test("unpairUser rejects foreign or missing pairings", () => {
  _resetPairingStoreForTests();
  const issued = issuePairingCode("+15550003333");
  completePairing(issued.code, "owner");
  assert.equal(unpairUser("other").ok, false);
  assert.equal(unpairUser("owner", "+19999999999").ok, false);
});

test("env SPECTRUM_USER_MAP wins over durable pairs on conflict", () => {
  _resetPairingStoreForTests();
  const issued = issuePairingCode("+15550001111");
  completePairing(issued.code, "from-pair");
  const merged = mergeUserMaps({ "+15550001111": "from-env" });
  assert.equal(merged["+15550001111"], "from-env");
});

test("loadState throws on corrupt pairing JSON instead of wiping", () => {
  _resetPairingStoreForTests();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "spectrum_pairs.json"), "{not-json", "utf8");
  assert.throws(() => getPairedUserMap(), /Corrupt spectrum pairing store/);
});

test("saveState uses restrictive permissions on dir and file", () => {
  _resetPairingStoreForTests();
  issuePairingCode("+15550003333");
  const file = join(dir, "spectrum_pairs.json");
  const fileMode = statSync(file).mode & 0o777;
  const dirMode = statSync(dir).mode & 0o777;
  // On some CI filesystems mode bits are masked; require owner-only write at least.
  assert.equal(fileMode & 0o077, 0, `file mode should be 0600-ish, got ${fileMode.toString(8)}`);
  assert.equal(dirMode & 0o077, 0, `dir mode should be 0700-ish, got ${dirMode.toString(8)}`);
  // Re-chmod existing dir to prove ensurePairStorePermissions hardens it.
  chmodSync(dir, 0o755);
  issuePairingCode("+15550004444");
  assert.equal(statSync(dir).mode & 0o777 & 0o077, 0);
});

test("concurrent worker pairing keeps all updates", async () => {
  _resetPairingStoreForTests();
  const workerUrl = new URL("./pairing-lock-worker.mjs", import.meta.url);
  const workerCount = 8;
  const results = await Promise.all(
    Array.from({ length: workerCount }, (_, index) =>
      new Promise((resolve, reject) => {
        const worker = new Worker(workerUrl, {
          workerData: { dataDir: dir, index },
        });
        worker.on("message", resolve);
        worker.on("error", reject);
        worker.on("exit", (code) => {
          if (code !== 0) reject(new Error(`worker exited with code ${code}`));
        });
      }),
    ),
  );

  for (const result of results) {
    assert.equal(result.ok, true, result.error || "worker pairing failed");
  }

  const map = getPairedUserMap();
  assert.equal(Object.keys(map).length, workerCount);
  for (const result of results) {
    assert.equal(map[result.address], result.userId);
  }
  assert.equal(existsSync(join(dir, "spectrum_pairs.lock")), false);
});
