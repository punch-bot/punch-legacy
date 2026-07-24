import * as routines from "./routines.js";

const INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS) || 60_000;

let timer = null;
let onFireCallback = null;

async function tick() {
  const now = Date.now();
  const due = routines.listAll().filter(
    (r) => r.type === "heartbeat" && r.enabled && r.nextRunAt <= now,
  );

  for (const r of due) {
    try {
      if (onFireCallback) await onFireCallback(r);
    } catch (err) {
      console.error(`[heartbeat] fire ${r.id} failed:`, err.message);
      continue;
    }
    routines.markFired(r);
  }

  timer = setTimeout(tick, INTERVAL_MS);
}

export function startHeartbeat(fireCallback) {
  onFireCallback = fireCallback;
  const active = routines
    .listAll()
    .filter((r) => r.type === "heartbeat" && r.enabled);
  console.log(`[heartbeat] started (${active.length} active)`);
  timer = setTimeout(tick, INTERVAL_MS);
}

export function stopHeartbeat() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  onFireCallback = null;
}
