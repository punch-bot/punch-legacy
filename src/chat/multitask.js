// Isolated Pi worker processes for multitasking (supervisor /workers API).

import * as store from "../memory.js";
import { apiUrlFor } from "../agent.js";
import { formatMessageTimestamp } from "../timezone.js";
import { multitaskPrompt } from "../prompt-blocks.js";
import { supervisorAuth } from "../core/config.js";
import { reply } from "../core/discord.js";
import { registry } from "../core/registry.js";

function activeTurnText(uid) {
  const turn = registry.activeTurns.get(uid);
  const lines = [];
  if (turn) {
    const elapsed = Math.round((Date.now() - turn.startedAt) / 1000);
    const detail = turn.detail ? ` — ${turn.detail}` : "";
    lines.push(`Main turn: **${turn.phase}** (${elapsed}s)${detail}`);
  } else {
    const queue = registry.userQueues.get(uid);
    if (queue?.length) lines.push(`Queue: ${queue.length} request(s) waiting`);
  }
  return lines.length ? lines.join("\n") : "No active turn.";
}

function isMainChatBusy(uid) {
  return registry.activeTurns.has(uid) || (registry.userQueues.get(uid)?.length > 0);
}

function shouldUseMultitaskWorker(uid, opts = {}) {
  if (opts.forceQueue || opts.pigeonFrom) return false;
  if (!store.getUserSettings(uid).multitaskEnabled) return false;
  return isMainChatBusy(uid);
}

function buildMultitaskPrompt(text, contextMessages = [], sentAt) {
  return multitaskPrompt(text, contextMessages, sentAt);
}

async function deliverWorkerToChannel(worker, content) {
  if (!worker?.channelId) return false;
  try {
    const channel = await registry.client.channels.fetch(worker.channelId);
    const payload = { content, allowedMentions: { parse: [] } };
    if (worker.messageId) {
      await channel.send({
        ...payload,
        reply: { messageReference: worker.messageId, failIfNotExists: false },
      });
    } else {
      await channel.send(payload);
    }
    return true;
  } catch (err) {
    console.warn(`[workers] channel delivery failed:`, err.message);
    return false;
  }
}

async function startMultitaskWorker(uid, { channelId, messageId, text, contextMessages = [], opts = {}, messageCreatedAt }) {
  const url = apiUrlFor(uid);
  if (!url) return { ok: false, error: "No sandbox assigned." };

  const kind = opts.workerKind || "coding";
  const timeoutMinutes = Math.max(1, Math.min(30, opts.timeoutMinutes || 10));
  const sentAt = formatMessageTimestamp(messageCreatedAt, store.getUserSettings(uid).timeZone);
  const prompt = buildMultitaskPrompt(text, contextMessages, sentAt);

  try {
    const res = await fetch(`${url}/workers`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: supervisorAuth() },
      body: JSON.stringify({
        kind,
        prompt,
        channelId,
        messageId,
        source: "multitask",
        model: opts.model || undefined,
        timeoutMs: timeoutMinutes * 60_000,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(body.slice(0, 200) || `worker API ${res.status}`);
    }
    const { worker } = await res.json();
    return { ok: true, worker };
  } catch (err) {
    if (/Worker limit reached/i.test(err.message)) {
      console.log(`[multitask] uid=${uid} worker limit — falling back to queue`);
      return { ok: false, fallbackQueue: true, error: err.message };
    }
    return { ok: false, error: err.message };
  }
}

async function trySpawnMultitaskWorker(message, text, contextMessages = [], opts = {}) {
  const uid = opts.userId ?? message.author.id;
  const result = await startMultitaskWorker(uid, {
    channelId: message.channelId,
    messageId: message.id,
    messageCreatedAt: message.createdTimestamp,
    text,
    contextMessages,
    opts,
  });
  if (result.ok) {
    await reply(
      message,
      `🧵 Started subtask \`${result.worker.id.slice(0, 8)}\` (${result.worker.kind}) — I'll reply here when done.`,
    );
    return true;
  }
  if (result.fallbackQueue) return false;
  await reply(message, `⚠️ Could not start subtask: ${result.error}`);
  return true;
}

async function listActiveWorkers(uid) {
  const url = apiUrlFor(uid);
  if (!url) return [];
  try {
    const res = await fetch(`${url}/workers`, { headers: { authorization: supervisorAuth() } });
    if (!res.ok) return [];
    const { workers } = await res.json();
    return (workers || []).filter((worker) => worker.active || ["queued", "running"].includes(worker.status));
  } catch {
    return [];
  }
}

async function activeStatusText(uid) {
  const lines = [activeTurnText(uid)];
  const workers = await listActiveWorkers(uid);
  if (workers.length) {
    lines.push(
      `Workers: ${workers
        .slice(0, 5)
        .map((worker) => `\`${worker.id.slice(0, 8)}\` ${worker.kind} **${worker.status}**`)
        .join(", ")}`,
    );
  }
  if (lines.length === 1 && lines[0] === "No active turn.") return lines[0];
  return lines.join("\n");
}

export {
  activeTurnText,
  isMainChatBusy,
  shouldUseMultitaskWorker,
  buildMultitaskPrompt,
  deliverWorkerToChannel,
  startMultitaskWorker,
  trySpawnMultitaskWorker,
  listActiveWorkers,
  activeStatusText,
};
