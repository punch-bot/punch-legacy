import { readFileSync, writeFileSync } from "node:fs";
import * as store from "./memory.js";
import * as sandbox from "./sandbox-manager.js";

const PENDING_FILE = "/state/pending_pigeons.json";
const PENDING_TTL_MS = 10 * 60 * 1000;
const PAIR_WINDOW_MS = 5 * 60 * 1000;
const PAIR_MAX = 2;

const rateEvents = new Map();
const scheduledTimers = new Map();
const bufferByMessageId = new Map();

let pendingSeq = 0;

function newPendingId() {
  pendingSeq += 1;
  return `pg_${Date.now().toString(36)}_${pendingSeq.toString(36)}`;
}

function loadPending() {
  try {
    return JSON.parse(readFileSync(PENDING_FILE, "utf8"));
  } catch {
    return {};
  }
}

function savePending(all) {
  writeFileSync(PENDING_FILE, JSON.stringify(all, null, 2));
}

function prunePending(all) {
  const now = Date.now();
  let changed = false;
  for (const [id, p] of Object.entries(all)) {
    if (now - (p.createdAt || 0) > PENDING_TTL_MS) {
      delete all[id];
      changed = true;
    }
  }
  if (changed) savePending(all);
  return all;
}

function rateKey(recipientId, from) {
  return `${recipientId}:${from || "*"}`;
}

function pruneRateEvents(key, windowMs) {
  const now = Date.now();
  const list = rateEvents.get(key) || [];
  const kept = list.filter((ts) => now - ts < windowMs);
  if (kept.length) rateEvents.set(key, kept);
  else rateEvents.delete(key);
  return kept;
}

export function checkRateLimit(recipientId, from, userSettings) {
  const count = Math.max(1, Number(userSettings.pigeonRateLimitCount) || 5);
  const windowMs = Math.max(60_000, Number(userSettings.pigeonRateLimitWindowMs) || 600_000);

  const recipientKey = rateKey(recipientId, "*");
  const recipientHits = pruneRateEvents(recipientKey, windowMs);
  if (recipientHits.length >= count) {
    return {
      ok: false,
      reason: `rate limit: max ${count} agent pigeons per ${Math.round(windowMs / 60_000)} min`,
    };
  }

  if (from) {
    const pairKey = rateKey(recipientId, from);
    const pairHits = pruneRateEvents(pairKey, PAIR_WINDOW_MS);
    if (pairHits.length >= PAIR_MAX) {
      return {
        ok: false,
        reason: `rate limit: max ${PAIR_MAX} pigeons from **${from}** per ${PAIR_WINDOW_MS / 60_000} min`,
      };
    }
  }

  return { ok: true };
}

export function recordPigeon(recipientId, from) {
  const us = store.getUserSettings(recipientId);
  const windowMs = Math.max(60_000, Number(us.pigeonRateLimitWindowMs) || 600_000);
  const now = Date.now();

  const recipientKey = rateKey(recipientId, "*");
  const rList = pruneRateEvents(recipientKey, windowMs);
  rList.push(now);
  rateEvents.set(recipientKey, rList);

  if (from) {
    const pairKey = rateKey(recipientId, from);
    const pList = pruneRateEvents(pairKey, PAIR_WINDOW_MS);
    pList.push(now);
    rateEvents.set(pairKey, pList);
  }
}

export function isDeniedSender({ from, userSettings }) {
  if (!from) return false;
  const denied = userSettings.deniedPigeonSenders || [];
  return denied.includes(from);
}

export function shouldSkipPermission({ from, hop, userSettings }) {
  const hopNum = Number(hop) || 0;
  if (hopNum > 0) return true;
  if (isDeniedSender({ from, userSettings })) return false;
  const trusted = userSettings.trustedPigeonSenders || [];
  if (from && trusted.includes(from)) return true;
  if (!userSettings.pigeonAskUnknown) return true;
  return false;
}

export function createPending({ recipientId, from, text, hop }) {
  const all = prunePending(loadPending());
  const pendingId = newPendingId();
  all[pendingId] = {
    recipientId,
    from,
    text,
    hop: Number(hop) || 0,
    status: "pending",
    createdAt: Date.now(),
  };
  savePending(all);
  return pendingId;
}

export function getPending(pendingId) {
  const all = prunePending(loadPending());
  return all[pendingId] || null;
}

export function deletePending(pendingId) {
  const all = prunePending(loadPending());
  if (!all[pendingId]) return false;
  delete all[pendingId];
  savePending(all);
  return true;
}

export function updatePending(pendingId, patch) {
  const all = prunePending(loadPending());
  const p = all[pendingId];
  if (!p) return null;
  all[pendingId] = { ...p, ...patch };
  savePending(all);
  return all[pendingId];
}

export function cancelScheduled(pendingId) {
  const timer = scheduledTimers.get(pendingId);
  if (timer) {
    clearTimeout(timer);
    scheduledTimers.delete(pendingId);
  }
  for (const [msgId, pid] of bufferByMessageId.entries()) {
    if (pid === pendingId) bufferByMessageId.delete(msgId);
  }
  updatePending(pendingId, { status: "cancelled" });
}

export function getPendingIdForMessage(messageId) {
  return bufferByMessageId.get(messageId) || null;
}

export function scheduleExecution({ pendingId, bufferSec, onRun, onCancel }) {
  cancelScheduled(pendingId);

  const sec = Math.max(0, Math.min(30, Number(bufferSec) || 0));
  if (sec <= 0) {
    onRun().catch((err) => console.error(`[pigeon-gate] run failed:`, err.message));
    return;
  }

  updatePending(pendingId, { status: "buffering", bufferSec: sec });

  const timer = setTimeout(async () => {
    scheduledTimers.delete(pendingId);
    const p = getPending(pendingId);
    if (!p || p.status === "cancelled") return;
    try {
      await onRun();
    } catch (err) {
      console.error(`[pigeon-gate] buffered run failed:`, err.message);
    }
  }, sec * 1000);

  scheduledTimers.set(pendingId, timer);

  return {
    trackMessage(messageId) {
      bufferByMessageId.set(messageId, pendingId);
    },
    async cancel() {
      if (scheduledTimers.has(pendingId)) {
        cancelScheduled(pendingId);
        if (onCancel) await onCancel();
        return true;
      }
      return false;
    },
  };
}

export function userIdForSandboxName(name) {
  if (!name) return null;
  return sandbox.loadUsers().find((u) => u.name === name)?.userId || null;
}

export function clampBufferSeconds(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(30, Math.floor(v));
}

export function clampRateLimit(count, minutes) {
  const c = Math.max(1, Math.min(30, Math.floor(Number(count) || 5)));
  const m = Math.max(1, Math.min(60, Math.floor(Number(minutes) || 10)));
  return { count: c, windowMs: m * 60_000 };
}
