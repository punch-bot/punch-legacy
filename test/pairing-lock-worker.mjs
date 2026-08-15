import { parentPort, workerData } from "node:worker_threads";

if (!workerData) {
  console.log("pairing-lock-worker is a worker_threads entry; run via spectrum-pairing.test.mjs");
  process.exit(0);
}

process.env.DATA_DIR = workerData.dataDir;
const { issuePairingCode, completePairing } = await import("../src/spectrum/pairing.js");

try {
  const i = workerData.index;
  const address = `+1555000${String(i).padStart(4, "0")}`;
  const issued = issuePairingCode(address);
  const done = completePairing(issued.code, `user-${i}`);
  parentPort.postMessage({
    ok: done.ok,
    address: done.ok ? done.address : address,
    userId: `user-${i}`,
    error: done.ok ? null : done.error,
  });
} catch (err) {
  parentPort.postMessage({
    ok: false,
    address: null,
    userId: null,
    error: err?.message || String(err),
  });
}
