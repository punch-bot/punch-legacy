import { getWorkerSettings, listWorkers, setWorkerCap, startWorker, stopWorker, workerLogs } from "/usr/local/lib/worker-manager.mjs";

function botAuth() {
  return "Bearer " + (process.env.PUNCH_BOT_TOKEN || "");
}

function notifyBot(path, progress) {
  const delivery = {
    channelId: progress.channelId || null,
    messageId: progress.messageId || null,
    source: progress.source || null,
  };
  return async (payload) => {
    await fetch(`http://bot:4098/workers/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: botAuth(),
      },
      body: JSON.stringify({ userId: process.env.SANDBOX_USER_ID || "", worker: { ...payload, ...delivery } }),
    });
  };
}

export function handleWorkerRoutes(req, res, url) {
  if (req.method === "GET" && url.pathname === "/workers/settings") {
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ settings: getWorkerSettings() })); return true;
  }

  if (req.method === "POST" && url.pathname === "/workers/settings") {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 1024) req.destroy(); });
    req.on("end", () => {
      try {
        const { cap } = JSON.parse(body || "{}");
        if (cap === undefined || cap === null) { res.writeHead(400); res.end(JSON.stringify({ error: "Missing cap" })); return; }
        const settings = setWorkerCap(cap);
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ settings }));
      } catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: error.message })); }
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/workers") {
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ workers: listWorkers() })); return true;
  }

  if (req.method === "POST" && url.pathname === "/workers") {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 25_000) req.destroy(); });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const delivery = {
          channelId: payload.channelId || null,
          messageId: payload.messageId || null,
          source: payload.source || null,
        };
        const worker = startWorker({
          ...payload,
          notifyProgress: notifyBot("progress", { ...delivery, ...payload }),
          notify: notifyBot("complete", { ...delivery, ...payload }),
        });
        res.writeHead(202, { "content-type": "application/json" }); res.end(JSON.stringify({ worker }));
      } catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: error.message })); }
    });
    return true;
  }

  const workerMatch = url.pathname.match(/^\/workers\/([a-f0-9-]{8,64})(?:\/(stop|logs))?$/i);
  if (workerMatch && req.method === "POST" && workerMatch[2] === "stop") {
    const worker = stopWorker(workerMatch[1]);
    if (!worker) { res.writeHead(404); res.end(JSON.stringify({ error: "Worker not found" })); return true; }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ worker })); return true;
  }
  if (workerMatch && req.method === "GET" && workerMatch[2] === "logs") {
    const data = workerLogs(workerMatch[1]);
    if (!data) { res.writeHead(404); res.end(JSON.stringify({ error: "Worker not found" })); return true; }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(data)); return true;
  }

  return false;
}
