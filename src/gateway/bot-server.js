// Bot HTTP API (:4098). Workers progress/complete push, routine CRUD,
// collab endpoints, state endpoints, and pigeon/notify delivery.

import { createServer } from "node:http";
import * as routines from "../routines.js";
import * as collabs from "../collabs.js";
import * as state from "../state.js";
import * as statistics from "../statistics.js";
import * as sandbox from "../sandbox-manager.js";
import { BOT_HTTP_PORT, botHttpAuth } from "../core/config.js";
import { registry } from "../core/registry.js";
import { verifyRoutineUser } from "../chat/routines-fire.js";
import { userTimeZone } from "../commands/prefix.js";
import { resolvePeerSandbox, isRegisteredSandboxName } from "../pigeon-peer.js";
import { sandboxNameForUser } from "../agent.js";
import { notifyPigeonDM, handleAgentPigeon } from "./pigeon.js";

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

/** Registered Discord owner of the sandbox that made this request, or null when
 *  the peer can't be resolved to a registered sandbox (callers then fall back
 *  to header-only checks so behavior degrades gracefully, never stricter). */
async function peerOwnerId(req) {
  const peer = await resolvePeerSandbox(req);
  if (peer?.peer !== "sandbox") return null;
  return sandbox.loadUsers().find((u) => u.name === peer.name)?.userId || null;
}

/** Throw a 403 when a claimed Discord user doesn't match the requesting sandbox
 *  owner. No-op when the peer resolves to nothing or to the bot itself. */
async function requireUserForPeer(req, claimedUserId) {
  const ownerId = await peerOwnerId(req);
  if (ownerId && claimedUserId && ownerId !== claimedUserId) {
    const err = new Error("userId does not match the requesting sandbox owner");
    err.status = 403;
    throw err;
  }
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

const botHttpServer = createServer(async (req, res) => {
  if (!botHttpAuth(req)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Punch API"' });
    return void res.end("Unauthorized");
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  let body;
  try {
    body = await readBody(req);
  } catch {
    body = null;
  }

  if (url.pathname === "/workers/progress" && req.method === "POST") {
    const userId = body?.userId;
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
    const headerUserId = req.headers["x-discord-user-id"] || null;
    if (headerUserId && headerUserId !== userId) {
      res.writeHead(403, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: "userId does not match x-discord-user-id header" }));
    }
    try {
      await requireUserForPeer(req, userId);
    } catch (err) {
      res.writeHead(403, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: err.message }));
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
    const userId = body?.userId;
    const worker = body?.worker;
    if (!userId || !worker?.id) {
      res.writeHead(400, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: "Missing userId or worker" }));
    }
    const headerUserId = req.headers["x-discord-user-id"] || null;
    if (headerUserId && headerUserId !== userId) {
      res.writeHead(403, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: "userId does not match x-discord-user-id header" }));
    }
    try {
      await requireUserForPeer(req, userId);
    } catch (err) {
      res.writeHead(403, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: err.message }));
    }
    registry.workerProgressSent.delete(`${userId}:${worker.id}`);
    try {
      const isSubtask = worker.source === "multitask" || worker.channelId;
      const label = isSubtask ? "subtask" : "worker";
      const icon = worker.status === "succeeded" ? "✅" : worker.status === "stopped" ? "🛑" : "⚠️";
      const detail = worker.status === "succeeded" ? (worker.result || "_(no output)_") : (worker.error || worker.result || "Worker stopped without output.");
      const content = `${icon} **${worker.kind} ${label} complete** \`${String(worker.id).slice(0, 8)}\` (${worker.status})\n${detail.slice(-1_700)}`;
      const delivered = await deliverWorkerToChannel(worker, content);
      if (!delivered) {
        const dm = await registry.client.users.createDM(userId);
        await dm.send(content);
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
      const headerUserId = req.headers["x-discord-user-id"] || null;
      await requireUserForPeer(req, headerUserId);

      if (req.method === "GET" && url.pathname === "/routines/list") {
        const userId = verifyRoutineUser(url.searchParams.get("userId"), headerUserId);
        if (!userId) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Missing userId" }));
        }
        const list = routines.listRoutines(userId);
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ routines: list }));
      }

      if (req.method === "POST" && url.pathname === "/routines/create") {
        if (!body) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Invalid JSON" }));
        }
        const userId = verifyRoutineUser(body.userId, headerUserId);
        if (!userId || !body.type || !body.payload) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Missing userId, type, or payload" }));
        }
        if (body.type !== "heartbeat" && !body.channelId) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Missing channelId (required for non-heartbeat types)" }));
        }
        const timezone = body.timezone || userTimeZone(userId);
        let schedule = body.schedule;
        if (body.when) {
          schedule = routines.parseRecurrence(body.when, body.recurrence || "once", timezone);
        }
        if (!schedule) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Missing schedule or when" }));
        }
        const routine = routines.addRoutine({
          userId,
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
        const userId = verifyRoutineUser(body.userId, headerUserId);
        if (!userId) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Missing userId" }));
        }
        const ok = routines.removeRoutine(deleteMatch[1], userId);
        res.writeHead(ok ? 200 : 404, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ success: ok }));
      }

      const pauseMatch = url.pathname.match(/^\/routines\/([^/]+)\/pause$/);
      if (req.method === "POST" && pauseMatch) {
        if (!body) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Invalid JSON" }));
        }
        const userId = verifyRoutineUser(body.userId, headerUserId);
        if (!userId) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Missing userId" }));
        }
        const r = routines.pauseRoutine(pauseMatch[1], userId);
        res.writeHead(r ? 200 : 404, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ routine: r }));
      }

      const resumeMatch = url.pathname.match(/^\/routines\/([^/]+)\/resume$/);
      if (req.method === "POST" && resumeMatch) {
        if (!body) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Invalid JSON" }));
        }
        const userId = verifyRoutineUser(body.userId, headerUserId);
        if (!userId) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Missing userId" }));
        }
        const r = routines.resumeRoutine(resumeMatch[1], userId);
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
      const peer = await resolvePeerSandbox(req);
      if (peer?.peer !== "sandbox" || !isRegisteredSandboxName(peer.name, sandbox.loadUsers())) {
        res.writeHead(403, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: "Collaboration calls require a registered sandbox." }));
      }
      const actor = peer.name;
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

  // State API endpoints
  if (url.pathname.startsWith("/state/")) {
    try {
      const headerUserId = req.headers["x-discord-user-id"] || null;
      if (!headerUserId) {
        res.writeHead(400, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: "Missing x-discord-user-id header" }));
      }
      await requireUserForPeer(req, headerUserId);
      if (req.method === "GET" && url.pathname === "/state/activity") {
        const type = url.searchParams.get("type") || undefined;
        const limit = Number(url.searchParams.get("limit")) || 20;
        const activities = state.getActivities(headerUserId, { type, limit });
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ activities }));
      }

      if (req.method === "GET" && url.pathname === "/state/stats") {
        const stats = state.getActivityStats(headerUserId);
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify(stats));
      }

      if (req.method === "GET" && url.pathname === "/state/statistics") {
        const period = url.searchParams.get("period") || "week";
        if (!statistics.STATISTICS_PERIODS.includes(period)) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "Invalid period" }));
        }
        const usage = state.getUsageStatistics(headerUserId, period);
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
      const peer = await resolvePeerSandbox(req);
      const recipientSandbox = sandboxNameForUser(recipientId);
      const callerOk =
        peer?.peer === "bot" ||
        (peer?.peer === "sandbox" && recipientSandbox && peer.name === recipientSandbox);
      if (!callerOk || !isRegisteredSandboxName(from, sandbox.loadUsers())) {
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
