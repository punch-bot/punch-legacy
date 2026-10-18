// Cancellation is routine. Only an unresponsive Pi warrants a restart.
export async function abortPiTurn({ rpc, waitTurn, forceKillPi, graceMs, reason }) {
  const settled = waitTurn();
  // The waiter may reject if the child exits while abort is in flight.
  settled.catch(() => {});
  let timer;
  try {
    await Promise.race([
      (async () => {
        await rpc("abort", {}, graceMs);
        const state = await rpc("get_state", {}, graceMs);
        if (state.data?.isStreaming !== false) await settled;
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Pi did not settle after abort")), graceMs);
      }),
    ]);
  } catch {
    forceKillPi(`${reason}: abort did not settle`);
  } finally {
    clearTimeout(timer);
    settled.cancel();
  }
}
