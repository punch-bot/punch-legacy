import { readFileSync } from "node:fs";
import { getUserSettings } from "./memory.js";
import { sanitizeProgressText } from "./progress-ui.js";
import { doctorTokenFor, USERS_FILE } from "./sandbox-manager.js";
import { supervisorAuth } from "./core/config.js";
import { catalogModel, loadCatalog } from "./model-catalog.js";

const DEFAULT_SERVER = (process.env.PI_SERVER_URL || "").replace(/\/$/, "");
const DEFAULT_API_URL = (() => {
  try {
     const u = new URL(DEFAULT_SERVER);
     u.port = "4097";
     return u.toString().replace(/\/$/, "");
  } catch {
     return DEFAULT_SERVER + ":4097";
  }
})();
const MODEL = process.env.PI_MODEL || "opencode/big-pickle";
const [PROVIDER_ID, ...rest] = MODEL.split("/");
const MODEL_ID = rest.join("/");
const DIR_BASE = process.env.PI_REMOTE_DIR || "/work";
const TIMEOUT_MS = (Number(process.env.PI_TIMEOUT) || 1800) * 1000;

let _extraMap = {};

const SANDBOX_MAP = (() => {
  try { return JSON.parse(process.env.SANDBOX_MAP || "{}"); }
  catch { return {}; }
})();

function sandboxMap() {
  return { ...SANDBOX_MAP, ..._extraMap };
}

export function reloadSandboxMap() {
  try {
    const users = JSON.parse(readFileSync(USERS_FILE, "utf8"));
    _extraMap = {};
    for (const u of users) _extraMap[u.userId] = `http://sandbox-${u.name}:4096`;
  } catch { _extraMap = {}; }
}

function serverFor(userId) {
  const m = sandboxMap();
  if (!userId) return DEFAULT_SERVER;
  return m[userId] || null;
}

export function sandboxNameForUser(userId) {
  if (!userId) return null;
  try {
    const users = JSON.parse(readFileSync(USERS_FILE, "utf8"));
    const u = users.find((x) => x.userId === userId);
    if (u) return u.name;
  } catch {}
  const srv = serverFor(userId);
  if (!srv) return null;
  try {
    const host = new URL(srv).hostname;
    const m = host.match(/^sandbox-(.+)$/);
    return m ? m[1] : null;
  } catch {
    const m = String(srv).match(/sandbox-([^:/]+)/);
    return m ? m[1] : null;
  }
}

const MAX_ACTIVITY_LINES = 150;
const activityLogs = new Map();

export function appendActivityLog(userId, line) {
  if (!userId || !line) return;
  let buf = activityLogs.get(userId);
  if (!buf) {
    buf = [];
    activityLogs.set(userId, buf);
  }
  const ts = new Date().toISOString().slice(11, 19);
  buf.push(`[${ts}] ${line}`);
  if (buf.length > MAX_ACTIVITY_LINES) buf.splice(0, buf.length - MAX_ACTIVITY_LINES);
}

export function getActivityLogs(userId, tail = 30) {
  const buf = activityLogs.get(userId) || [];
  return buf.slice(-Math.max(1, Math.min(tail, MAX_ACTIVITY_LINES)));
}

if (!DEFAULT_SERVER && (process.env.PUNCH_REQUIRE_PI_URL === "1")) {
  throw new Error("PI_SERVER_URL is not set but PUNCH_REQUIRE_PI_URL=1; Punch uses dynamic /sandbox create instead");
}

function headers(url) {
  return { "content-type": "application/json", authorization: supervisorAuth(url) };
}

function userDir(userId) {
  const m = sandboxMap();
  if (userId && m[userId]) return DIR_BASE;
  return userId ? `${DIR_BASE}/users/${userId}` : DIR_BASE;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function abortableSleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => { clearTimeout(timer); resolve(); };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function api(path, body, baseUrl, signal = null) {
  if (!baseUrl) throw new Error("No sandbox server assigned for this user");
  const srv = baseUrl;
  const url = `${srv}${path}`;
  let lastCode;
  for (let attempt = 0; attempt < 8; attempt++) {
     let res;
     try {
        res = await fetch(url, {
          method: "POST",
          headers: headers(url),
          body: JSON.stringify(body ?? {}),
          signal: signal || AbortSignal.timeout(TIMEOUT_MS),
        });
     } catch (err) {
        if (err.name === "TimeoutError") {
          throw new Error(`pi server timed out after ${TIMEOUT_MS / 1000}s (${srv})`);
        }
        if (err.name === "AbortError" || (signal && signal.aborted)) throw err;
        lastCode = err.cause?.code || err.code || err.message;
        await abortableSleep(2000, signal);
        continue;
      }
       if (!res.ok) {
          const t = await res.text().catch(() => "");
          const transient = res.status >= 500 && /pi not ready|pi not running|pi restarted/i.test(t);
          if (transient && attempt < 7) {
            await abortableSleep(1500, signal);
            continue;
          }
         throw piApiError(res.status, t);
      }
     return res.json();
  }
  throw new Error(`cannot reach pi server at ${srv} (${lastCode})`);
}

const IDLE_MS = (Number(process.env.PI_IDLE_TIMEOUT) || 1800) * 1000;
const CEIL_MS = (Number(process.env.PI_MAX) || 1800) * 1000;
const HARD_MS = (Number(process.env.PI_HARD_TIMEOUT) || 1800) * 1000;

export function isStuckTurnError(message) {
  return /timed out|stalled|ceiling|hard timeout|hard cap|silent for|turn hung/i.test(String(message || ""));
}

export async function restartPiGateway(userId, reason = "stuck turn") {
  const name = sandboxNameForUser(userId);
  const apiUrl = apiUrlFor(userId);
  const baseUrl = serverFor(userId);
  if (!name || !apiUrl) return false;
  try {
    const auth = supervisorAuth(apiUrl);
    const res = await fetch(`${apiUrl}/doctor/fix`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: auth,
        "x-punch-doctor-token": doctorTokenFor(name),
      },
      body: JSON.stringify({ action: "restart-gateway" }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => ({}));
    const ok = res.ok || res.status === 202;
    console.log(
      `[pi] gateway restart (${reason}) uid=${userId}: ${ok ? "ok" : res.status} ${body.message || ""}`.trim(),
    );
    if (ok && baseUrl) {
      for (let i = 0; i < 20; i++) {
        await abortableSleep(500);
        try {
          const health = await fetch(`${baseUrl}/health`, {
            headers: headers(baseUrl),
            signal: AbortSignal.timeout(2_000),
          });
          if (health.ok) {
            console.log(`[pi] gateway healthy again uid=${userId} after ${i + 1} poll(s)`);
            break;
          }
        } catch {}
      }
    }
    return ok;
  } catch (err) {
    console.error(`[pi] gateway restart failed uid=${userId}:`, err.message);
    return false;
  }
}

async function recoverStuckGateway(sessionId, userId, reason) {
  try {
    await abortSession(sessionId, userId);
  } catch {}
  await restartPiGateway(userId, reason);
}

function idleThresholdMs(userId) {
  const s = getUserSettings(userId);
  if (s && s.disableIdleTimeout) return Infinity;
  return IDLE_MS;
}

async function consumeEvents(sid, signal, onEvent, baseUrl, userId, onReady = null) {
  let readinessReported = false;
  const ready = (connected) => {
    if (readinessReported) return;
    readinessReported = true;
    onReady?.(connected);
  };
  if (!baseUrl) {
    ready(false);
    return;
  }
  const srv = baseUrl;
  let res;
  try {
     res = await fetch(`${srv}/event`, { headers: headers(srv), signal });
  } catch {
     ready(false);
     return;
  }
  if (!res.ok || !res.body) {
     ready(false);
     return;
  }
  ready(true);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
     while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            let ev;
            try {
              ev = JSON.parse(line.slice(5).trim());
            } catch {
              continue;
            }
            if (ev?.properties?.sessionID !== sid) continue;
            const type = ev.type;
            const p = ev.properties || {};
            const part = p.part || {};
            const shortSid = sid.slice(0, 8);
            if (type === "message.part.updated") {
              if (part.type === "tool") {
                const name = /^[a-z][a-z0-9_-]{0,63}$/i.test(part.tool || "") ? part.tool : "tool";
                const status = /^(running|done|error)$/i.test(part.state?.status || "")
                  ? part.state.status
                  : "updated";
                const title = sanitizeProgressText(part.state?.title, 140);
                const toolMsg = `[pi:${shortSid}] tool ${name} is ${status}${title ? `: ${title}` : ""}`;
                console.log(toolMsg);
                if (userId) appendActivityLog(userId, toolMsg);
              }
            }
            onEvent(ev);
          }
        }
     }
  } catch (err) {} finally {
     ready(false);
  }
}

export function progressEventFingerprint(event) {
  if (event?.type !== "session.progress" || event.properties?.heartbeat === true) return null;
  const p = event.properties || {};
  return JSON.stringify([
    p.phase,
    p.status,
    p.current,
    p.toolCalls,
    p.goal,
    p.finding,
    p.next,
  ]);
}

const KEEPALIVE_PHASES = new Set(["thinking", "writing", "compacting", "retrying", "working", "tool", "milestone"]);

export function classifyIdleWatchdogEvent(event, lastFingerprint = "") {
  if (!event || typeof event !== "object") {
    return { resetMeaningful: false, resetKeepalive: false, fingerprint: lastFingerprint, phase: null };
  }

  if (event.type === "session.progress") {
    const phase = String(event.properties?.phase || "").toLowerCase() || null;
    if (event.properties?.heartbeat === true) {
      return {
        resetMeaningful: false,
        resetKeepalive: KEEPALIVE_PHASES.has(phase),
        fingerprint: lastFingerprint,
        phase,
      };
    }
    const fingerprint = progressEventFingerprint(event);
    if (fingerprint != null && fingerprint !== lastFingerprint) {
      return { resetMeaningful: true, resetKeepalive: true, fingerprint, phase };
    }
    return { resetMeaningful: false, resetKeepalive: false, fingerprint: lastFingerprint, phase };
  }

  if (event.type === "message.part.updated" && event.properties?.part?.type === "tool") {
    return { resetMeaningful: true, resetKeepalive: true, fingerprint: lastFingerprint, phase: "tool" };
  }
  if (event.type === "message.part.delta") {
    return { resetMeaningful: true, resetKeepalive: true, fingerprint: lastFingerprint, phase: "writing" };
  }

  return { resetMeaningful: false, resetKeepalive: false, fingerprint: lastFingerprint, phase: null };
}

const TOOL_STALE_MS = (Number(process.env.PI_TOOL_STALE_TIMEOUT) || 1800) * 1000;

async function postMessageWithIdle(sid, path, body, onProgress, signal = null, baseUrl, userId = null) {
  if (!baseUrl) throw new Error("No sandbox server assigned for this user");
  const srv = baseUrl;
  const url = `${srv}${path}`;
  const postAC = new AbortController();
  const sseAC = new AbortController();

  if (signal) {
    if (signal.aborted) {
      postAC.abort();
      sseAC.abort();
    } else {
      signal.addEventListener("abort", () => {
        postAC.abort();
        sseAC.abort();
      }, { once: true });
    }
  }
  const start = Date.now();
  let lastMeaningful = Date.now();
  let lastKeepalive = Date.now();
  let lastProgressFingerprint = "";
  let lastPhase = "starting";
  let recoveryReason = null;
  const bumpMeaningful = () => {
    const now = Date.now();
    lastMeaningful = now;
    lastKeepalive = now;
  };
  const bumpKeepalive = () => { lastKeepalive = Date.now(); };

  let resolveSseReady;
  const sseReady = new Promise((resolve) => { resolveSseReady = resolve; });
  const sseReadyTimer = setTimeout(() => {
    resolveSseReady(false);
    sseAC.abort();
  }, 5000);
  void consumeEvents(sid, sseAC.signal, (ev) => {
    const decision = classifyIdleWatchdogEvent(ev, lastProgressFingerprint);
    if (decision.phase) lastPhase = decision.phase;
    if (decision.resetMeaningful) {
      bumpMeaningful();
      lastProgressFingerprint = decision.fingerprint;
    } else if (decision.resetKeepalive) {
      bumpKeepalive();
    }
    if (onProgress) {
      try { onProgress(ev); } catch {}
    }
  }, srv, userId, (connected) => {
    clearTimeout(sseReadyTimer);
    resolveSseReady(connected);
  });

  let idleIv;
  let hardTimer;
  const idleMs = idleThresholdMs(userId);
  const toolStaleMs = idleMs === Infinity ? Infinity : TOOL_STALE_MS;
  const idle = new Promise((_, reject) => {
     idleIv = setInterval(() => {
        if (postAC.signal.aborted) return;
        const now = Date.now();
        const silentFor = now - lastKeepalive;
        const staleFor = now - lastMeaningful;
        const toolLike = lastPhase === "tool" || lastPhase === "working" || lastPhase === "milestone";
        if (silentFor > idleMs) {
          recoveryReason = "stall";
          postAC.abort();
          reject(new Error(`pi stalled: no progress for ${Math.round(idleMs / 1000)}s (session stuck)`));
        } else if (toolLike && staleFor > toolStaleMs) {
          recoveryReason = "stall";
          postAC.abort();
          reject(new Error(`pi stalled: ${lastPhase} hung for ${Math.round(toolStaleMs / 1000)}s without real progress`));
        } else if (now - start > CEIL_MS) {
          recoveryReason = "ceiling";
          postAC.abort();
          reject(new Error(`pi turn exceeded ${CEIL_MS / 1000}s ceiling`));
        }
     }, 5000);
  });
  const hardDeadline = new Promise((_, reject) => {
     hardTimer = setTimeout(() => {
        recoveryReason = "hard-cap";
        postAC.abort();
        sseAC.abort();
        reject(new Error(`pi turn exceeded ${HARD_MS / 1000}s hard timeout`));
     }, HARD_MS);
  });

  const doPost = (async () => {
    await sseReady;
    let lastCode;
    for (let attempt = 0; attempt < 8; attempt++) {
      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: headers(url),
          body: JSON.stringify(body ?? {}),
          signal: postAC.signal,
        });
      } catch (err) {
        if (postAC.signal.aborted) throw err;
        lastCode = err.cause?.code || err.code || err.message;
        bumpKeepalive();
        await abortableSleep(2000, postAC.signal);
        if (postAC.signal.aborted) throw new Error("aborted");
        continue;
      }
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        if (res.status >= 500 && /pi not ready|pi not running|pi restarted/i.test(t) && attempt < 7) {
          bumpKeepalive();
          await abortableSleep(1500, postAC.signal);
          if (postAC.signal.aborted) throw new Error("aborted");
          continue;
        }
        throw piApiError(res.status, t);
      }
      return res.json();
    }
    throw new Error(`cannot reach pi server at ${srv} (${lastCode})`);
  })();
  doPost.catch(() => {});

  try {
    return await Promise.race([doPost, idle, hardDeadline]);
  } catch (err) {
    if (!recoveryReason && isStuckTurnError(err?.message)) {
      recoveryReason = "stuck-turn";
    }
    throw err;
  } finally {
    clearInterval(idleIv);
    clearTimeout(hardTimer);
    clearTimeout(sseReadyTimer);
    sseAC.abort();
    postAC.abort();
    if (recoveryReason) {
      void recoverStuckGateway(sid, userId, recoveryReason);
    }
  }
}

const CONTEXT_LIMITS = {
  "anthropic/claude-3-5-sonnet": 200000,
  "anthropic/claude-sonnet-4-5": 200000,
  "anthropic/claude-3-7-sonnet": 200000,
  "openai/gpt-4o": 128000,
  "openai/gpt-4.1": 1000000,
  "google/gemini-2.0-flash": 1000000,
  "google/gemini-2.5-pro": 1000000,
  "mistral/mistral-large-4": 1048576,
  "mistral/mistral-medium-3.5": 262144,
  "opencode/big-pickle": 200000,
  "opencode/deepseek-v4-flash-free": 200000,
  "opencode/mimo-v2.5-free": 200000,
  "opencode/laguna-s-2.1-free": 200000,
  "opencode/north-mini-code-free": 256000,
  "opencode/nemotron-3-ultra-free": 1000000,
};
const DEFAULT_CONTEXT_LIMIT = Number(process.env.PI_CONTEXT_LIMIT) || 128000;

export function contextLimitFor(model, apiUrl = null) {
  if (!model) return DEFAULT_CONTEXT_LIMIT;
  const reported = apiUrl ? catalogModel(apiUrl, model) : null;
  if (reported?.contextWindow) return reported.contextWindow;
  if (CONTEXT_LIMITS[model]) return CONTEXT_LIMITS[model];
  const [prov] = model.split("/");
  const prefixHit = Object.entries(CONTEXT_LIMITS).find(([k]) => model.startsWith(k) || k.startsWith(model));
  if (prefixHit) return prefixHit[1];
  if (prov === "anthropic") return 200000;
  if (prov === "opencode" || prov === "opencode-go") return 200000;
  if (prov === "nvidia") return 131072;
  if (prov === "mistral") return 262144;
  return DEFAULT_CONTEXT_LIMIT;
}

function extractContextUsage(info, model, apiUrl = null) {
  const t = info?.tokens;
  if (!t) return null;
  const input = Number(t.input) || 0;
  const output = Number(t.output) || 0;
  const reasoning = Number(t.reasoning) || 0;
  const cacheRead = Number(t.cache?.read) || 0;
  const cacheWrite = Number(t.cache?.write) || 0;
  const used = input + cacheRead + cacheWrite;
  const limit = contextLimitFor(model, apiUrl);
  if (!used && !output) return null;
  return {
    used,
    output,
    reasoning,
    limit,
    model,
    pct: limit ? Math.min(100, Math.round((used / limit) * 100)) : null,
  };
}

function piApiError(status, body) {
  let msg = body;
  try {
    msg = JSON.parse(body)?.error || body;
  } catch {}
  return new Error(`pi API ${status}: ${String(msg).slice(0, 300)}`);
}

function formatAgentError(info) {
  const err = info?.error;
  if (!err) return "";
  const msg = err.data?.message || err.message || err.name || "unknown error";
  const model = info?.providerID
    ? `${info.providerID}/${info.modelID || "?"}`
    : "";
  return model ? `⚠️ ${model}: ${msg}` : `⚠️ ${msg}`;
}

function partsToOutput(parts) {
  const text = (parts || [])
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text)
    .join("")
    .trim();
  if (text) return text;

  const toolOut = (parts || [])
    .filter((p) => p.type === "tool" && p.state?.output)
    .map((p) => String(p.state.output).trim())
    .filter(Boolean);
  if (!toolOut.length) return "";
  return toolOut.map((o) => "```\n" + o + "\n```").join("\n");
}

async function latestAssistantOutput(sid, userId) {
  const srv = serverFor(userId);
  if (!srv) return "";
  const dir = userDir(userId);
  const q = `?directory=${encodeURIComponent(dir)}`;
  const res = await fetch(`${srv}/session/${sid}/message${q}`, { headers: headers(srv) });
  if (!res.ok) return "";
  const msgs = await res.json();
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if ((m.info?.role || m.role) !== "assistant") continue;
    const err = formatAgentError(m.info);
    if (err) return err;
    const out = partsToOutput(m.parts);
    if (out) return out;
  }
  return "";
}

export async function createSession(userId) {
  const dir = userDir(userId);
  const srv = serverFor(userId);
  const q = `?directory=${encodeURIComponent(dir)}`;
  const s = await api(`/session${q}`, {}, srv);
  return s.id;
}

async function fetchActiveModel(userId, signal = null) {
  const active = { activeProvider: PROVIDER_ID, activeModel: MODEL_ID, thinkingLevel: null };
  const apiUrl = apiUrlFor(userId);
  if (!apiUrl) return active;
  try {
    const res = await fetch(`${apiUrl}/model`, {
      headers: headers(apiUrl),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(2000)]) : AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const d = await res.json();
      if (d && d.model) {
        const [p, ...r] = d.model.split("/");
        active.activeProvider = p;
        active.activeModel = r.join("/");
      }
      active.thinkingLevel = d?.thinkingLevel || null;
    }
  } catch (err) {
    console.error(`[pi] failed to fetch active model from supervisor for ${userId}:`, err.message);
  }
  return active;
}

export async function runAgent(message, sessionId = null, onProgress = null, signal = null, userId = null, attachments = [], onSession = null) {
  const srv = serverFor(userId);
  if (!srv) throw new Error("No sandbox assigned. Ask an admin to create one with /sandbox, or wait for your turn.");
  const dir = userDir(userId);
  let sid = sessionId || (await createSession(userId));
  onSession?.(sid);
  const q = `?directory=${encodeURIComponent(dir)}`;

  const systemPath = "/work/.pi/SYSTEM.md";
  let sysPrompt = "";
  try {
    const res = await fetch(`${srv}/file/content?path=${encodeURIComponent(systemPath)}&directory=${encodeURIComponent("/work")}`, {
      headers: headers(srv),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    const text = d.type === "binary" ? Buffer.from(String(d.content), "base64").toString() : String(d.content ?? "");
    sysPrompt = text.trim();
    if (!sysPrompt) throw new Error("file is empty");
  } catch (err) {
    throw new Error(`Could not load Pi system prompt from ${systemPath}: ${err.message}`);
  }

  if (userId) {
    const settings = getUserSettings(userId);
    if (settings.autoCompressThreshold > 0) {
      sysPrompt += `\n\n## Context pruning threshold\n\nPUNCH_CONTEXT_PRUNING_THRESHOLD=${settings.autoCompressThreshold}\nAt this usage level, compress stale complete ranges with compress_context before continuing. Whole-session compaction only when explicitly requested.`;
    }
    if (settings.gitCoAuthor) {
      sysPrompt += `\n\n## Git conventions\n\nAppend to every commit (skip if already present):\n\n\`\`\`text\nCo-Authored-By: Punch <punch@orb.gay>\n\`\`\`\n\nUse \`git commit -m "message" -m "Co-Authored-By: Punch <punch@orb.gay>"\` so the trailer is its own paragraph.`;
    }
  }

  const { activeProvider, activeModel, thinkingLevel } = await fetchActiveModel(userId);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const parts = [{ type: "text", text: message }];

      const msg = await postMessageWithIdle(
        sid,
        `/session/${sid}/message${q}`,
        {
          model: { providerID: activeProvider, modelID: activeModel },
          thinkingLevel,
          system: sysPrompt,
          parts,
        },
        onProgress,
        signal,
        srv,
        userId,
      );

      let out = formatAgentError(msg.info) || partsToOutput(msg.parts);
      if (!out) {
        out = await latestAssistantOutput(sid, userId);
      }

      const cost = Number(msg.info?.cost) || 0;
      await loadCatalog(srv).catch(() => null);
      const usage = extractContextUsage(msg.info, `${activeProvider}/${activeModel}`, srv);
      const tokenUsage = msg.info?.tokens || null;
      return {
        text: out,
        sessionId: sid,
        cost,
        usage,
        tokenUsage,
        activity: msg.info?.activity || null,
        error: formatAgentError(msg.info) || null,
        attachments: [],
      };
    } catch (err) {
      if (attempt === 0 && sessionId && /session not found/i.test(err.message)) {
        console.log(`[pi] session ${sid} not found, creating new one`);
        sid = await createSession(userId);
        onSession?.(sid);
        continue;
      }
      throw err;
    }
  }
}

export async function getFile(filePath, userId) {
  const srv = serverFor(userId);
  const dir = userDir(userId);
  const q = `?path=${encodeURIComponent(filePath)}&directory=${encodeURIComponent(dir)}`;
  const res = await fetch(`${srv}/file/content${q}`, { headers: headers(srv) });
  if (!res.ok) {
     const t = await res.text().catch(() => "");
     throw new Error(`pi getFile API ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const buffer =
     data.type === "binary"
        ? Buffer.from(String(data.content), "base64")
        : Buffer.from(String(data.content ?? ""), "utf8");
  return { buffer, name: filePath.split("/").pop() || "file" };
}

export async function steerSession(sessionId, text, userId) {
  const srv = serverFor(userId);
  if (!srv) return { ok: false, error: "No sandbox assigned." };
  const dir = userDir(userId);
  const q = `?directory=${encodeURIComponent(dir)}`;
  const sid = sessionId || "active";
  try {
    const res = await fetch(`${srv}/session/${encodeURIComponent(sid)}/steer${q}`, {
      method: "POST",
      headers: headers(srv),
      body: JSON.stringify({ parts: [{ type: "text", text: String(text ?? "") }] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { ok: false, error: `steer API ${res.status}: ${t.slice(0, 160)}` };
    }
    const data = await res.json().catch(() => ({}));
    return { ok: true, disposition: data.disposition || null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function abortSession(sessionId, userId) {
   const srv = serverFor(userId);
   if (!srv) return false;
   const dir = userDir(userId);
   const q = `?directory=${encodeURIComponent(dir)}`;
   try {
      const path = sessionId
         ? `/session/${encodeURIComponent(sessionId)}/abort${q}`
         : `/abort${q}`;
      const res = await fetch(`${srv}${path}`, {
         method: "POST",
         headers: headers(srv),
         body: "{}",
         signal: AbortSignal.timeout(5000),
      });
      return res.ok;
   } catch {
      return false;
   }
}

export function apiUrlFor(userId) {
  const srv = serverFor(userId);
  if (!srv) return null;
  try {
     const u = new URL(srv);
     u.port = "4097";
     return u.toString().replace(/\/$/, "");
  } catch {
     return srv.replace(/:4096$/, ":4097");
  }
}

export async function listBackgroundTasks(userId) {
  const url = `${apiUrlFor(userId)}/tasks`;
  const res = await fetch(url, { headers: headers(url) });
  if (!res.ok) {
     const t = await res.text().catch(() => "");
     throw new Error(`listBackgroundTasks API ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

export async function killBackgroundTask(pid, userId) {
  const url = `${apiUrlFor(userId)}/tasks/kill`;
  const res = await fetch(url, {
     method: "POST",
     headers: headers(url),
     body: JSON.stringify({ pid }),
  });
  if (!res.ok) {
     const t = await res.text().catch(() => "");
     throw new Error(`killBackgroundTask API ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

export async function runBackgroundTask(command, userId) {
  const url = `${apiUrlFor(userId)}/tasks/run`;
  const res = await fetch(url, {
     method: "POST",
     headers: headers(url),
     body: JSON.stringify({ command }),
  });
  if (!res.ok) {
     const t = await res.text().catch(() => "");
     throw new Error(`runBackgroundTask API ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

export async function execCommand(command, timeout = 30000, userId) {
  const url = `${apiUrlFor(userId)}/tasks/exec`;
  const res = await fetch(url, {
     method: "POST",
     headers: headers(url),
     body: JSON.stringify({ command, timeout }),
     signal: AbortSignal.timeout(timeout + 5000),
  });
  if (!res.ok) {
     const t = await res.text().catch(() => "");
     throw new Error(`exec API ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

export async function setSecret(key, value, userId) {
  const url = `${apiUrlFor(userId)}/secrets`;
  const res = await fetch(url, {
     method: "POST",
     headers: { ...headers(url), "Content-Type": "application/json" },
     body: JSON.stringify({ key, value }),
  });
  if (!res.ok) {
     const t = await res.text().catch(() => "");
     throw new Error(`setSecret API ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

export async function getSecrets(userId) {
  const url = `${apiUrlFor(userId)}/secrets`;
  const res = await fetch(url, { headers: headers(url) });
  if (!res.ok) {
     const t = await res.text().catch(() => "");
     throw new Error(`getSecrets API ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

export async function setEnv(key, value, userId) {
  const url = `${apiUrlFor(userId)}/env`;
  const res = await fetch(url, {
     method: "POST",
     headers: { ...headers(url), "Content-Type": "application/json" },
     body: JSON.stringify({ key, value }),
  });
  if (!res.ok) {
     const t = await res.text().catch(() => "");
     throw new Error(`setEnv API ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

export async function syncWorkerCap(userId) {
  const url = apiUrlFor(userId);
  if (!url) return null;
  const cap = getUserSettings(userId).multitaskWorkersCap;
  const res = await fetch(`${url}/workers/settings`, {
    method: "POST",
    headers: { ...headers(url), "Content-Type": "application/json" },
    body: JSON.stringify({ cap }),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`workers settings API ${res.status}: ${text.slice(0, 200)}`);
  }
  const { settings } = await res.json();
  return settings;
}

export async function getWorkerSettings(userId) {
  const url = apiUrlFor(userId);
  if (!url) return null;
  const res = await fetch(`${url}/workers/settings`, { headers: headers(url) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`workers settings API ${res.status}: ${text.slice(0, 200)}`);
  }
  const { settings } = await res.json();
  return settings;
}

export async function summarizeSession(sessionId, userId, signal = null) {
  const srv = serverFor(userId);
  if (!srv) throw new Error("No sandbox assigned. Ask an admin to create one with /sandbox, or wait for your turn.");
  if (!sessionId) throw new Error("No active session in this channel to compress. Send a message first.");
  const dir = userDir(userId);
  const q = `?directory=${encodeURIComponent(dir)}`;

  const { activeProvider, activeModel, thinkingLevel } = await fetchActiveModel(userId, signal);

  return api(
    `/session/${sessionId}/summarize${q}`,
    { model: { providerID: activeProvider, modelID: activeModel }, providerID: activeProvider, modelID: activeModel, thinkingLevel },
    srv,
    signal,
  );
}

export async function getEnv(userId, signal = null) {
  const url = `${apiUrlFor(userId)}/env`;
  const res = await fetch(url, { headers: headers(url), signal });
  if (!res.ok) {
     const t = await res.text().catch(() => "");
     throw new Error(`getEnv API ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

