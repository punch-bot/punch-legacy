import { randomUUID } from "node:crypto";
import { applyMemoryAudit, memoryAuditSnapshot, newAuditRun, preamble } from "./memory.js";

const contexts = new Map();
const audits = new Map();
const CONTEXT_TTL_MS = 60 * 60_000;
const AUDIT_TTL_MS = 2 * 60 * 60_000;

function forbidden(message) {
  return Object.assign(new Error(message), { status: 403 });
}

export function beginMemoryRecall(userId, channelId, isDm, guildId = null, serverNotes = isDm === true) {
  const now = Date.now();
  for (const [id, context] of contexts) if (context.expires <= now) contexts.delete(id);
  const id = randomUUID();
  contexts.set(id, { userId: String(userId), channelId: String(channelId), isDm: isDm === true, guildId: guildId ? String(guildId) : null, serverNotes: serverNotes === true, expires: now + CONTEXT_TTL_MS });
  return id;
}

export function endMemoryRecall(id) {
  contexts.delete(id);
}

export function recallForSandbox(identity, body) {
  if (!identity?.userId) throw Object.assign(new Error("Unauthorized"), { status: 401 });
  if (!body || typeof body.query !== "string" || body.query.length > 2_000) {
    throw Object.assign(new Error("A query of at most 2,000 characters is required."), { status: 400 });
  }
  let channelId;
  let guildId = null;
  let isDm = false;
  let serverNotes = false;
  if (body.contextId) {
    const context = contexts.get(body.contextId);
    if (!context || context.userId !== String(identity.userId) || context.expires <= Date.now()) {
      throw Object.assign(new Error("Memory context is unavailable for this sandbox/turn."), { status: 403 });
    }
    channelId = context.channelId;
    guildId = context.guildId;
    isDm = context.isDm;
    serverNotes = context.serverNotes;
  }
  const text = preamble(identity.userId, channelId, body.query, { isDm, guildId, serverNotes, maxChars: body.maxChars, limit: body.limit, markUsed: true });
  return { text };
}

export function beginMemoryAudit(userId, contextId = null) {
  const now = Date.now();
  for (const [id, audit] of audits) if (audit.expires <= now) audits.delete(id);
  if (contextId) {
    const existing = audits.get(contextId);
    if (!existing || existing.userId !== String(userId)) throw forbidden("Memory audit context expired or was lost; explicitly resume the failed routine to start a new audit.");
    return contextId;
  }
  const id = randomUUID();
  audits.set(id, { userId: String(userId), expires: now + AUDIT_TTL_MS, run: newAuditRun() });
  return id;
}

export function endMemoryAudit(id) {
  audits.delete(id);
}

export function auditForSandbox(identity, body) {
  if (!identity?.userId) throw Object.assign(new Error("Unauthorized"), { status: 401 });
  const audit = audits.get(body?.contextId);
  if (!audit || audit.userId !== String(identity.userId) || audit.expires <= Date.now()) {
    throw forbidden("Memory audit is only available during the scheduled weekly audit.");
  }
  if (body.action === "list") return { text: memoryAuditSnapshot(identity.userId, body.offset) };
  if (body.action === "apply") {
    const counts = applyMemoryAudit(identity.userId, body.changes, audit.run);
    const missing = counts.missing.length ? ` Unknown or already removed ids: ${counts.missing.join(", ")}.` : "";
    const skipped = counts.skipped ? ` Skipped ${counts.skipped} change(s) whose facts no longer exist or were restated by the user during this audit; leave those facts alone.${missing}` : "";
    return { text: `Applied: ${counts.added} added, ${counts.merged} merged away, ${counts.dropped} dropped, ${counts.fixed} fixed, ${counts.flagged} flagged unconfirmed.${skipped}`, counts };
  }
  throw Object.assign(new Error("action must be list or apply."), { status: 400 });
}
