// Plan gate: pending plan store, rate limits, expiry, and per-user decision
// policy. Pure logic only — no discord.js imports. The Discord-facing card /
// approve / deny flow lives in src/gateway/plan.js; this module mirrors
// pigeon-gate.js in shape.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as store from "./memory.js";

const PENDING_FILE = join(
  process.env.DATA_DIR || join(process.cwd(), "data"),
  "pending_plans.json",
);

export const PLAN_TTL_MS = 10 * 60 * 1000;
export const PLAN_RATE_WINDOW_MS = 10 * 60 * 1000;
export const PLAN_RATE_MAX = 5;
export const PLAN_MAX_PENDING_PER_USER = 3;
export const PLAN_MODES = ["confirm", "auto", "off"];

const rateEvents = new Map();
const metrics = {
  proposed: 0,
  pending: 0,
  approved: 0,
  autoApproved: 0,
  denied: 0,
  notMyTask: 0,
  expired: 0,
  rateLimited: 0,
};

let seq = 0;

function newPlanId() {
  seq += 1;
  return `pl_${Date.now().toString(36)}_${seq.toString(36)}`;
}

function loadPending() {
  try {
    return JSON.parse(readFileSync(PENDING_FILE, "utf8"));
  } catch {
    return {};
  }
}

function savePending(all) {
  mkdirSync(dirname(PENDING_FILE), { recursive: true });
  const tmp = `${PENDING_FILE}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 2));
  renameSync(tmp, PENDING_FILE);
}

function prunePending(all) {
  const now = Date.now();
  let changed = false;
  for (const [id, p] of Object.entries(all)) {
    if (now - (p.createdAt || 0) > PLAN_TTL_MS) {
      delete all[id];
      changed = true;
      if (p.status === "pending") metrics.expired += 1;
    }
  }
  if (changed) savePending(all);
  return all;
}

function pruneRateEvents(userId) {
  const now = Date.now();
  const list = rateEvents.get(userId) || [];
  const kept = list.filter((ts) => now - ts < PLAN_RATE_WINDOW_MS);
  if (kept.length) rateEvents.set(userId, kept);
  else rateEvents.delete(userId);
  return kept;
}

export function checkPlanRateLimit(userId) {
  const hits = pruneRateEvents(userId);
  if (hits.length >= PLAN_RATE_MAX) {
    return {
      ok: false,
      reason: `rate limit: max ${PLAN_RATE_MAX} plan proposals per ${Math.round(PLAN_RATE_WINDOW_MS / 60_000)} min`,
    };
  }
  return { ok: true };
}

export function recordPlanProposal(userId) {
  const list = pruneRateEvents(userId);
  list.push(Date.now());
  rateEvents.set(userId, list);
}

// `auto` and `off` both skip the prompt; `off` additionally suppresses the
// "Approve & stop asking" button (see gateway/plan.js). Peer-origin plans
// (a2a:*) always require approval regardless of the user's mode.
export function planRequiresApproval(userId, origin) {
  if (origin && String(origin).startsWith("a2a:")) return true;
  return (store.getUserSettings(userId).planGate || "confirm") === "confirm";
}

export function createPending({
  userId,
  sandboxName,
  summary,
  steps,
  touches,
  commands,
  est,
  origin,
  channelId,
}) {
  const all = prunePending(loadPending());
  const planId = newPlanId();
  all[planId] = {
    planId,
    userId,
    sandboxName: sandboxName || null,
    summary: String(summary || "").slice(0, 500),
    steps: (steps || []).map((s) => String(s).slice(0, 300)).slice(0, 20),
    touches: (touches || []).map((s) => String(s).slice(0, 200)).slice(0, 20),
    commands: (commands || []).map((s) => String(s).slice(0, 200)).slice(0, 20),
    est: est ? String(est).slice(0, 60) : null,
    origin: origin || "user",
    channelId: channelId || null,
    cardChannelId: null,
    cardMessageId: null,
    status: "pending",
    reason: null,
    noticePending: false,
    createdAt: Date.now(),
    decidedAt: null,
  };
  savePending(all);
  return planId;
}

export function getPending(planId) {
  const all = prunePending(loadPending());
  return all[planId] || null;
}

// Entry point for bot-server's /plan/propose: rate-limit + pending-cap checks,
// then either auto-approve (planGate auto/off for user-origin plans) or park
// the plan as pending so a card can ask for approval. Returns
// { planId?, decision: "pending"|"approved"|"denied", reason?, record? }.
export function submitPlanProposal(input) {
  const rl = checkPlanRateLimit(input.userId);
  if (!rl.ok) {
    metrics.rateLimited += 1;
    metrics.denied += 1;
    return { decision: "denied", reason: rl.reason };
  }
  if (countPendingForUser(input.userId) >= PLAN_MAX_PENDING_PER_USER) {
    metrics.denied += 1;
    return {
      decision: "denied",
      reason: `too many pending plans (max ${PLAN_MAX_PENDING_PER_USER}) — resolve the open plan cards first`,
    };
  }
  recordPlanProposal(input.userId);
  metrics.proposed += 1;
  const planId = createPending(input);
  if (!planRequiresApproval(input.userId, input.origin)) {
    metrics.autoApproved += 1;
    metrics.approved += 1;
    const record = updatePending(planId, {
      status: "approved",
      decisionSource: "auto",
      decidedAt: Date.now(),
    });
    return { planId, decision: "approved", record };
  }
  metrics.pending += 1;
  return { planId, decision: "pending", record: getPending(planId) };
}

export function updatePending(planId, patch) {
  const all = prunePending(loadPending());
  const p = all[planId];
  if (!p) return null;
  all[planId] = { ...p, ...patch };
  savePending(all);
  return all[planId];
}

export function countPendingForUser(userId) {
  const all = prunePending(loadPending());
  return Object.values(all).filter(
    (p) => p.userId === userId && p.status === "pending",
  ).length;
}

// Record a decision on a pending plan. `status` is one of
// approved | denied | not_my_task. Denial outcomes set noticePending so the
// next chat turn can tell the agent the plan was rejected.
export function resolvePlan(planId, { status, reason }) {
  const patch = {
    status,
    reason: reason ?? null,
    decidedAt: Date.now(),
    noticePending: status === "denied" || status === "not_my_task",
  };
  const updated = updatePending(planId, patch);
  if (!updated) return null;
  if (status === "approved") metrics.approved += 1;
  else if (status === "denied") metrics.denied += 1;
  else if (status === "not_my_task") metrics.notMyTask += 1;
  return updated;
}

// The bot can't inject context into a session mid-turn (the gateway only
// injects at turn boundaries), so denied plans are surfaced on the next turn's
// preamble instead — zero extra LLM calls.
export function consumeDeniedNotices(userId) {
  const all = prunePending(loadPending());
  const found = [];
  let changed = false;
  for (const p of Object.values(all)) {
    if (p.userId === userId && p.noticePending) {
      found.push(p);
      p.noticePending = false;
      changed = true;
    }
  }
  if (changed) savePending(all);
  return found;
}

export function getPlanGateStats() {
  const all = prunePending(loadPending());
  return {
    ...metrics,
    pendingNow: Object.values(all).filter((p) => p.status === "pending").length,
  };
}

export function resetPlanGateForTests() {
  rateEvents.clear();
  for (const key of Object.keys(metrics)) metrics[key] = 0;
  try {
    writeFileSync(PENDING_FILE, "{}");
  } catch {}
}
