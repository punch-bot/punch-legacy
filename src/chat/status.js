// Status text for the active main turn and running /workers.

import { apiUrlFor } from "../agent.js";
import { supervisorAuth } from "../core/config.js";
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

export { activeTurnText, listActiveWorkers, activeStatusText };
