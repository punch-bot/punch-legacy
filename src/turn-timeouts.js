// Deployment values are seconds. Reject values that overflow Node's timers.
export function timeoutSeconds(value, fallback) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 && seconds <= 2_147_483
    ? seconds : fallback;
}

export function turnTimeouts(env = process.env) {
  const request = timeoutSeconds(env.PI_TIMEOUT, 1800);
  const ceiling = timeoutSeconds(env.PI_MAX, request);
  const hard = timeoutSeconds(env.PI_HARD_TIMEOUT, ceiling);
  return { request, ceiling, hard };
}
