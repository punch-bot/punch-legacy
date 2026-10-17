import { workerData, parentPort } from "node:worker_threads";
import { MemoryDatabase } from "../../src/memory-db.js";

const db = new MemoryDatabase(workerData.dataDir);
for (let n = 0; n < workerData.count; n++) {
  db.insert("fact", "user", "concurrent-user", { id: `${workerData.worker}-${n}`, text: "concurrent durable fact", ts: Date.now() });
}
db.close();
parentPort.postMessage("done");
