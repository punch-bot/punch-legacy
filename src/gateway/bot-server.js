import { createServer } from "node:http";
import * as routines from "../routines.js";
import * as collabs from "../collabs.js";
import * as state from "../state.js";
import * as statistics from "../statistics.js";
import * as sandbox from "../sandbox-manager.js";
import { BOT_HTTP_PORT } from "../core/config.js";
import { registry } from "../core/registry.js";
import { chunk } from "../core/discord.js";
import { escapeStrayMarkdown } from "../discord-markdown.js";
import { verifyRoutineUser } from "../chat/routines-fire.js";
import { userTimeZone } from "../commands/prefix.js";
import { sandboxNameForUser } from "../agent.js";
import { notifyPigeonDM, handleAgentPigeon } from "./pigeon.js";
import { isRegisteredSandboxName } from "../pigeon-peer.js";
import { recallForSandbox } from "../memory-recall.js";

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => {
      try { resolve(JSON.parse(data)); } catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

async function deliverWorkerToChannel(worker, content) {
  if (!worker?.channelId) return false;
  try {
    const channel = await registry.client.channels.fetch(worker.channelId);
    for (const part of chunk(content)) {
      const payload = { content: part, allowedMentions: { parse: [] } };
      if (worker.messageId) {
        await channel.send({
          ...payload,
          reply: { messageReference: worker.messageId, failIfNotExists: false },
        });
      } else {
        await channel.send(payload);
      }
    }
    return true;
  } catch (err) {
    console.warn(`[workers] channel delivery failed:`, err.message);
    return false;
  }
}

const botHttpServer = createServer(async (req, res) => {
  const authHeader = req.headers.authorization || "";
  const authMatch = /^Bearer\s+(.+)$/i.exec(authHeader);
  const identity = authMatch ? await sandbox.resolveBotToken(authMatch[1]) : null;
  if (!identity) {
    res.writeHead(401, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ error: "Unauthorized" }));
  }
  req.sandboxIdentity = identity;

  const url = new URL(req.url, `http://${req.headers.host}`);

  let body;
  try {
    body = await readBody(req);
  } catch {
    body = null;
  }

  if (url.pathname === "/memory/recall" && req.method === "POST") {
    try {
      const result = recallForSandbox(req.sandboxIdentity, body);
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(error.status || 500, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: error.status ? error.message : "Memory recall unavailable." }));
    }
  }

  if (url.pathname === "/workers/progress" && req.method === "POST") {
    const userId = req.sandboxIdentity.userId;
    const worker = body?.worker;
    if (!userId || !worker?.id || !worker?.phase) {
      res.writeHead(400, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: "Missing userId or worker progress" }));
    }
    const phase = String(worker.phase);
    const allowed = new Set(["queued", "starting", "working", "tool", "finalizing", "timed_out", "failed"]);
    if (!allowed.has(phase)) {
      res.writeHead(400, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: "Invalid worker phase" }));
    }
    const now = Date.now();
    const key = `${userId}:${worker.id}`;
    const previous = registry.workerProgressSent.get(key);
    if (previous && now - previous < 4_000 && phase !== "failed" && phase !== "timed_out") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ success: true, throttled: true }));
    }
    registry.workerProgressSent.set(key, now);
    try {
      if (worker.channelId) {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ success: true, skipped: true }));
      }
      const icon = phase === "tool" ? "🛠️" : phase === "finalizing" ? "📦" : phase === "failed" || phase === "timed_out" ? "⚠️" : "⏳";
      const detail = String(worker.detail || "Working").replace(/[\r\n`]/g, " ").slice(0, 180);
      const dm = await registry.client.users.createDM(userId);
      await dm.send(`${icon} **${worker.kind || "Pi"} worker** \`${String(worker.id).slice(0, 8)}\`: ${detail}`);
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ success: true }));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: error.message }));
    }
  }

  if (url.pathname === "/workers/complete" && req.method === "POST") {
    const userId = req.sandboxIdentity.userId;
    const worker = body?.worker;
    if (!userId || !worker?.id) {
      res.writeHead(400, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: "Missing userId or worker" }));
    }
    registry.workerProgressSent.delete(`${userId}:${worker.id}`);
    try {
      const isSubtask = worker.source === "multitask" || worker.channelId;
      const label = isSubtask ? "subtask" : "worker";
      const icon = worker.status === "succeeded" ? "✅" : worker.status === "stopped" ? "🛑" : "⚠️";
      const detail = worker.status === "succeeded" ? (worker.result || "_(no output)_") : (worker.error || worker.result || "Worker stopped without output.");
      const content = `${icon} **${worker.kind} ${label} complete** \`${String(worker.id).slice(0, 8)}\` (${worker.status})\n${escapeStrayMarkdown(detail.slice(-1_700))}`;
      const delivered = await deliverWorkerToChannel(worker, content);
      if (!delivered) {
        const dm = await registry.client.users.createDM(userId);
        for (const part of chunk(content)) await dm.send({ content: part, allowedMentions: { parse: [] } });
      }
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ success: true }));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: error.message }));
    }
  }

  if (url.pathname.startsWith("/routines")) {
    try {
      const userId = req.sandboxIdentity.userId;

      if (req.method === "GET" && url.pathname === "/routines/list") {
        const verifiedId = verifyRoutineUser(url.searchParams.get("userId"), userId);
        if (!verifiedId) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Missing userId" }));
        }
        const list = routines.listRoutines(verifiedId);
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ routines: list }));
      }

      if (req.method === "POST" && url.pathname === "/routines/create") {
        if (!body) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Invalid JSON" }));
        }
        const verifiedId = verifyRoutineUser(body.userId, userId);
        if (!verifiedId || !body.type || !body.payload) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Missing userId, type, or payload" }));
        }
        if (body.type !== "heartbeat" && !body.channelId) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Missing channelId (required for non-heartbeat types)" }));
        }
        const timezone = body.timezone || userTimeZone(verifiedId);
        let schedule = body.schedule;
        if (body.when) {
          schedule = routines.parseRecurrence(body.when, body.recurrence || "once", timezone);
        }
        if (!schedule) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Missing schedule or when" }));
        }
        const routine = routines.addRoutine({
          userId: verifiedId,
          channelId: body.channelId,
          guildId: body.guildId || null,
          type: body.type,
          payload: body.payload,
          schedule,
          timezone,
        });
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ routine }));
      }

      const deleteMatch = url.pathname.match(/^\/routines\/([^/]+)$/);
      if (req.method === "DELETE" && deleteMatch) {
        if (!body) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Invalid JSON" }));
        }
        const verifiedId = verifyRoutineUser(body.userId, userId);
        if (!verifiedId) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Missing userId" }));
        }
        const ok = routines.removeRoutine(deleteMatch[1], verifiedId);
        res.writeHead(ok ? 200 : 404, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ success: ok }));
      }

      const pauseMatch = url.pathname.match(/^\/routines\/([^/]+)\/pause$/);
      if (req.method === "POST" && pauseMatch) {
        if (!body) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Invalid JSON" }));
        }
        const verifiedId = verifyRoutineUser(body.userId, userId);
        if (!verifiedId) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Missing userId" }));
        }
        const r = routines.pauseRoutine(pauseMatch[1], verifiedId);
        res.writeHead(r ? 200 : 404, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ routine: r }));
      }

      const resumeMatch = url.pathname.match(/^\/routines\/([^/]+)\/resume$/);
      if (req.method === "POST" && resumeMatch) {
        if (!body) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Invalid JSON" }));
        }
        const verifiedId = verifyRoutineUser(body.userId, userId);
        if (!verifiedId) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Missing userId" }));
        }
        const r = routines.resumeRoutine(resumeMatch[1], verifiedId);
        res.writeHead(r ? 200 : 404, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ routine: r }));
      }

      res.writeHead(404);
      return void res.end("Not Found");
    } catch (err) {
      res.writeHead(err.status || 500, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: err.message }));
    }
  }

  if (url.pathname.startsWith("/collabs")) {
    try {
      const actor = req.sandboxIdentity.name;
      if (req.method === "POST" && url.pathname === "/collabs/create") {
        if (!body?.reviewer || !body?.workspace) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Missing reviewer or workspace." }));
        }
        const collab = await collabs.create({ owner: actor, reviewer: String(body.reviewer).toLowerCase(), workspace: body.workspace });
        const reviewerId = sandbox.loadUsers().find((user) => user.name === collab.participants[1])?.userId;
        if (reviewerId) {
          const task = String(body.task || "Review future collaboration proposals carefully, run relevant tests, and request changes until code is good.").slice(0, 3000);
          handleAgentPigeon(reviewerId, actor, `Collaboration ${collab.id} started. Your clone is ${collab.workspaces[collab.participants[1]]}. ${task}`, 0).catch(() => {});
        }
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ collab }));
      }
      if (req.method === "GET" && url.pathname === "/collabs") {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ collabs: collabs.listFor(actor) }));
      }
      const match = url.pathname.match(/^\/collabs\/(col_[a-f0-9]{12})(?:\/(propose|review))?$/);
      if (!match) {
        res.writeHead(404);
        return void res.end("Not Found");
      }
      const [, id, action] = match;
      if (req.method === "GET" && !action) {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ collab: collabs.getFor(id, actor) }));
      }
      if (!body) {
        res.writeHead(400, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
      if (req.method === "POST" && action === "propose") {
        const collab = await collabs.propose({ id, actor, head: body.head });
        const reviewer = collab.proposal.reviewer;
        const reviewerId = sandbox.loadUsers().find((user) => user.name === reviewer)?.userId;
        if (reviewerId) {
          handleAgentPigeon(reviewerId, actor, `Collaboration ${id} needs review. Fetch branch ${collab.proposal.branch} at ${collab.proposal.head}, inspect diff and tests, then use the collab tool to approve or request changes.`, 0).catch(() => {});
        }
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ collab }));
      }
      if (req.method === "POST" && action === "review") {
        const collab = await collabs.review({ id, actor, approve: body.approve === true, notes: body.notes });
        if (collab.proposal.status === "merged") {
          for (const participant of collab.participants) {
            const userId = sandbox.loadUsers().find((user) => user.name === participant)?.userId;
            if (userId) notifyPigeonDM(userId, "collab", `Collaboration **${id}** auto-merged \`${collab.base.slice(0, 12)}\` into main.`).catch(() => {});
          }
        }
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ collab }));
      }
      res.writeHead(405);
      return void res.end("Method Not Allowed");
    } catch (error) {
      res.writeHead(error.status || 400, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: error.message }));
    }
  }

  if (url.pathname.startsWith("/state/")) {
    try {
      const userId = req.sandboxIdentity.userId;
      if (req.method === "GET" && url.pathname === "/state/activity") {
        const type = url.searchParams.get("type") || undefined;
        const limit = Number(url.searchParams.get("limit")) || 20;
        const activities = state.getActivities(userId, { type, limit });
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ activities }));
      }

      if (req.method === "GET" && url.pathname === "/state/stats") {
        const stats = state.getActivityStats(userId);
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify(stats));
      }

      if (req.method === "GET" && url.pathname === "/state/statistics") {
        const period = url.searchParams.get("period") || "week";
        if (!statistics.STATISTICS_PERIODS.includes(period)) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Invalid period" }));
        }
        const usage = state.getUsageStatistics(userId, period);
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify(usage));
      }

      res.writeHead(404);
      return void res.end("Not Found");
    } catch (err) {
      res.writeHead(err.status || 500, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: err.message }));
    }
  }

  if (!body) {
    res.writeHead(400);
    return void res.end("Invalid JSON");
  }

  try {
    if (req.method === "POST" && url.pathname === "/pigeon/notify") {
      const { recipientId, from, text, agent, hop } = body;
      if (!recipientId || !from || !text) {
        res.writeHead(400);
        return void res.end(JSON.stringify({ error: "Missing recipientId, from, or text" }));
      }
      const recipientSandbox = sandboxNameForUser(recipientId);
      const callerOk =
        req.sandboxIdentity.name === recipientSandbox &&
        isRegisteredSandboxName(from, sandbox.loadUsers());
      if (!callerOk) {
        res.writeHead(403);
        return void res.end(JSON.stringify({ error: "Pigeon sender verification failed" }));
      }
      if (agent) {
        handleAgentPigeon(recipientId, from, text, hop).catch(() => {});
      } else {
        notifyPigeonDM(recipientId, from, text).catch(() => {});
      }
      res.writeHead(200);
      return void res.end(JSON.stringify({ success: true }));
    }
    res.writeHead(404);
    return void res.end("Not Found");
  } catch (err) {
    res.writeHead(err.status || 500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
});

export function startBotHttpServer() {
  botHttpServer.listen(BOT_HTTP_PORT, "0.0.0.0", () => {
    console.log(`Bot HTTP API listening on port ${BOT_HTTP_PORT}`);
  });
}
