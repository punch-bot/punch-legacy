import { randomUUID } from "node:crypto";
import { preamble } from "./memory.js";

const contexts = new Map();
const CONTEXT_TTL_MS = 60 * 60_000;

export function beginMemoryRecall(userId, channelId, isDm) {
  const now = Date.now();
  for (const [id, context] of contexts) if (context.expires <= now) contexts.delete(id);
  const id = randomUUID();
  contexts.set(id, { userId: String(userId), channelId: String(channelId), isDm: isDm === true, expires: now + CONTEXT_TTL_MS });
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
  let isDm = false;
  if (body.contextId) {
    const context = contexts.get(body.contextId);
    if (!context || context.userId !== String(identity.userId) || context.expires <= Date.now()) {
      throw Object.assign(new Error("Memory context is unavailable for this sandbox/turn."), { status: 403 });
    }
    channelId = context.channelId;
    isDm = context.isDm;
  }
  const text = preamble(identity.userId, channelId, body.query, { isDm, maxChars: body.maxChars, limit: body.limit });
  return { text };
}
