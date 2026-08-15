/**
 * Durable iMessage ↔ Punch user pairing.
 * Unknown numbers get a 9-digit code; Discord `/pair <code>` binds them.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomInt } from "node:crypto";
import { normalizeAddressKey } from "./identity.js";

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), "data");
const PAIR_FILE = join(DATA_DIR, "spectrum_pairs.json");
const LOCK_FILE = `${PAIR_FILE}.lock`;
const CODE_TTL_MS = 30 * 60 * 1000;
const CODE_DIGITS = 9;
const LOCK_STALE_MS = 60_000;
const LOCK_RETRY_MS = 5;
const LOCK_MAX_WAIT_MS = 10_000;

function emptyState() {
  return { pairs: {}, pending: {} };
}

function loadState() {
  let text;
  try {
    text = readFileSync(PAIR_FILE, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return emptyState();
    throw err;
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    throw new Error(`Corrupt spectrum pairing store at ${PAIR_FILE}: ${detail}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Corrupt spectrum pairing store at ${PAIR_FILE}: expected object`);
  }
  return {
    pairs: raw.pairs && typeof raw.pairs === "object" && !Array.isArray(raw.pairs) ? raw.pairs : {},
    pending:
      raw.pending && typeof raw.pending === "object" && !Array.isArray(raw.pending)
        ? raw.pending
        : {},
  };
}

function sleepMs(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // busy-wait for short cross-process lock retries
  }
}

function acquirePairingLock() {
  ensurePairStorePermissions();
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(LOCK_FILE, "wx");
      try {
        writeFileSync(fd, `${process.pid}\n${Date.now()}`, "utf8");
      } catch {
        // lock file already open for write
      }
      return fd;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      try {
        const st = statSync(LOCK_FILE);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          unlinkSync(LOCK_FILE);
          continue;
        }
      } catch (stErr) {
        if (stErr?.code === "ENOENT") continue;
        throw stErr;
      }
      sleepMs(LOCK_RETRY_MS);
    }
  }
  throw new Error(`Timeout acquiring pairing store lock (${LOCK_FILE})`);
}

function releasePairingLock(fd) {
  try {
    if (typeof fd === "number") closeSync(fd);
  } catch {
    // ignore
  }
  try {
    if (existsSync(LOCK_FILE)) unlinkSync(LOCK_FILE);
  } catch {
    // ignore
  }
}

function withPairingLock(fn) {
  const fd = acquirePairingLock();
  try {
    return fn();
  } finally {
    releasePairingLock(fd);
  }
}

function ensurePairStorePermissions() {
  const dir = dirname(PAIR_FILE);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best-effort on platforms that ignore mode
  }
}

function saveState(state) {
  ensurePairStorePermissions();
  const temp = `${PAIR_FILE}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(temp, PAIR_FILE);
    try {
      chmodSync(PAIR_FILE, 0o600);
    } catch {
      // best-effort
    }
  } catch (error) {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      // keep original error
    }
    throw error;
  }
}

function pruneExpired(state, now = Date.now()) {
  let changed = false;
  for (const [code, entry] of Object.entries(state.pending)) {
    if (!entry || typeof entry !== "object" || !entry.expiresAt || entry.expiresAt <= now) {
      delete state.pending[code];
      changed = true;
    }
  }
  return changed;
}

/**
 * Address → Punch userId map from completed pairings.
 * @returns {Record<string, string>}
 */
export function getPairedUserMap() {
  const state = loadState();
  /** @type {Record<string, string>} */
  const out = {};
  for (const [address, userId] of Object.entries(state.pairs || {})) {
    const a = normalizeAddressKey(address) || String(address).trim();
    const u = String(userId || "").trim();
    if (a && u) out[a] = u;
  }
  return out;
}

/**
 * Merge env SPECTRUM_USER_MAP with durable pairings (env wins on conflict).
 * @param {Record<string, string>} [envMap]
 */
export function mergeUserMaps(envMap = {}) {
  return { ...getPairedUserMap(), ...(envMap && typeof envMap === "object" ? envMap : {}) };
}

function findPendingByAddress(state, addressKey, now) {
  for (const [code, entry] of Object.entries(state.pending)) {
    if (!entry || entry.expiresAt <= now) continue;
    const key = normalizeAddressKey(entry.address) || String(entry.address || "").trim();
    if (key && key === addressKey) return { code, entry };
  }
  return null;
}

function generateUniqueCode(state) {
  for (let i = 0; i < 40; i++) {
    const code = String(randomInt(10 ** (CODE_DIGITS - 1), 10 ** CODE_DIGITS));
    if (!state.pending[code]) return code;
  }
  throw new Error("Could not allocate a pairing code");
}

/**
 * Issue or refresh a pairing code for an unknown Spectrum sender address.
 * @param {string} address
 * @param {{ now?: number, ttlMs?: number }} [opts]
 * @returns {{ code: string, address: string, created: boolean, message: string }}
 */
export function issuePairingCode(address, opts = {}) {
  const raw = String(address || "").trim();
  const addressKey = normalizeAddressKey(raw) || raw;
  if (!addressKey) {
    throw new Error("Pairing requires a sender address");
  }

  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? CODE_TTL_MS;
  return withPairingLock(() => {
    const state = loadState();
    pruneExpired(state, now);

    const existing = findPendingByAddress(state, addressKey, now);
    if (existing) {
      return {
        code: existing.code,
        address: addressKey,
        created: false,
        message: formatPairingMessage(existing.code),
      };
    }

    const code = generateUniqueCode(state);
    state.pending[code] = {
      address: addressKey,
      createdAt: now,
      expiresAt: now + ttlMs,
    };
    saveState(state);
    return {
      code,
      address: addressKey,
      created: true,
      message: formatPairingMessage(code),
    };
  });
}

/**
 * @param {string} code
 */
export function formatPairingMessage(code) {
  return `Hey, i don't know who you are! Run /pair in discord together with your pairing code: ${code}`;
}

/**
 * @param {string} discordUsername
 */
export function formatPairingCompleteMessage(discordUsername) {
  const who = String(discordUsername || "").trim() || "your Discord account";
  return `Paired to ${who}! Send a message again to text your punch!`;
}

/**
 * Addresses paired to a Punch user id.
 * @param {string} userId
 * @returns {string[]}
 */
export function listPairedAddressesForUser(userId) {
  const uid = String(userId || "").trim();
  if (!uid) return [];
  const state = loadState();
  return Object.entries(state.pairs || {})
    .filter(([, pairedUid]) => String(pairedUid) === uid)
    .map(([address]) => address);
}

/**
 * Remove durable pairings for a Discord user.
 * @param {string} userId
 * @param {string | null | undefined} [address] Optional specific phone/email to unpair
 * @returns {{ ok: true, addresses: string[] } | { ok: false, error: string }}
 */
export function unpairUser(userId, address = null) {
  const uid = String(userId || "").trim();
  if (!uid) return { ok: false, error: "Missing Discord user id." };

  const target = address == null || address === ""
    ? null
    : normalizeAddressKey(String(address)) || String(address).trim();

  return withPairingLock(() => {
    const state = loadState();
    /** @type {string[]} */
    const removed = [];

    for (const [storedAddress, pairedUid] of Object.entries(state.pairs || {})) {
      if (String(pairedUid) !== uid) continue;
      const storedKey = normalizeAddressKey(storedAddress) || String(storedAddress).trim();
      if (target && storedKey !== target && storedAddress !== target) continue;
      removed.push(storedAddress);
    }

    if (removed.length === 0) {
      if (target) {
        return { ok: false, error: "That number is not paired to your Discord account." };
      }
      return { ok: false, error: "You don't have any paired phone numbers." };
    }

    for (const addr of removed) delete state.pairs[addr];
    saveState(state);
    return { ok: true, addresses: removed };
  });
}

/**
 * Complete pairing: bind pending code's address to a Discord/Punch userId.
 * @param {string} code
 * @param {string} userId
 * @param {{ now?: number }} [opts]
 * @returns {{ ok: true, address: string, userId: string } | { ok: false, error: string }}
 */
export function completePairing(code, userId, opts = {}) {
  const normalizedCode = String(code || "").trim().replace(/\s+/g, "");
  const uid = String(userId || "").trim();
  if (!/^\d{9}$/.test(normalizedCode)) {
    return { ok: false, error: "Pairing code must be 9 digits." };
  }
  if (!uid) {
    return { ok: false, error: "Missing Discord user id." };
  }

  const now = opts.now ?? Date.now();
  return withPairingLock(() => {
    const state = loadState();
    pruneExpired(state, now);
    const entry = state.pending[normalizedCode];
    if (!entry) {
      return { ok: false, error: "Unknown or expired pairing code. Text Punch again to get a new one." };
    }

    const address = normalizeAddressKey(entry.address) || String(entry.address).trim();
    state.pairs[address] = uid;
    delete state.pending[normalizedCode];
    // Drop any other pending codes for the same address.
    for (const [otherCode, other] of Object.entries(state.pending)) {
      const key = normalizeAddressKey(other?.address) || String(other?.address || "").trim();
      if (key === address) delete state.pending[otherCode];
    }
    saveState(state);
    return { ok: true, address, userId: uid };
  });
}

/**
 * Look up Punch userId for an address from durable pairs only.
 * @param {string} address
 */
export function pairedUserIdForAddress(address) {
  const key = normalizeAddressKey(address) || String(address || "").trim();
  if (!key) return null;
  const map = getPairedUserMap();
  return map[key] || null;
}

/** Test helper */
export function _resetPairingStoreForTests() {
  try {
    if (existsSync(PAIR_FILE)) unlinkSync(PAIR_FILE);
  } catch {
    // ignore
  }
  try {
    if (existsSync(LOCK_FILE)) unlinkSync(LOCK_FILE);
  } catch {
    // ignore
  }
}

export const PAIRING_CODE_TTL_MS = CODE_TTL_MS;
