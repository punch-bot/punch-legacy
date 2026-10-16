// Heartbeat routines are scheduled by the supervisor service. The bot only
// delivers a fire when the supervisor calls POST /internal/routines/fire.

export function startHeartbeat() {
  console.warn("[heartbeat] local scheduler is unused; the supervisor fires heartbeats");
}

export function stopHeartbeat() {}
