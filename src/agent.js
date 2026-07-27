import { readFileSync } from "node:fs";
import { getUserSettings } from "./memory.js";
import { sanitizeProgressText } from "./progress-ui.js";

// Talks to the sandbox's Pi gateway (HTTP on :4096 over `pi --mode rpc`).
// All tool execution (bash/read/write/edit) happens SERVER-SIDE in the sandbox
// container — the bot never runs a command locally and never holds model credentials.
//
// Flow: POST /session (once per channel) -> POST /session/{id}/message per turn.
// The Punch pi-gateway adapts this HTTP shape onto Pi RPC prompt/abort/compact/events.
// Env vars OPENCODE_* are legacy aliases kept for compose compatibility.

const DEFAULT_SERVER = (process.env.OPENCODE_SERVER_URL || "").replace(/\/$/, "");
const DEFAULT_API_URL = (() => {
  try {
     const u = new URL(DEFAULT_SERVER);
     u.port = "4097";
     return u.toString().replace(/\/$/, "");
  } catch {
     return DEFAULT_SERVER + ":4097";
  }
})();
const MODEL = process.env.OPENCODE_MODEL || "opencode/big-pickle";
const [PROVIDER_ID, ...rest] = MODEL.split("/");
const MODEL_ID = rest.join("/");
const USER = process.env.OPENCODE_SERVER_USERNAME || "opencode";
const PASS = process.env.OPENCODE_SERVER_PASSWORD || "";
const DIR_BASE = process.env.OPENCODE_REMOTE_DIR || "/work";
const TIMEOUT_MS = (Number(process.env.OPENCODE_TIMEOUT) || 300) * 1000;

// Map of Discord user IDs to sandbox hostnames.
// e.g. {"12345":"sandbox-punch:4096","67890":"sandbox-ember:4096"}
// Seeded from SANDBOX_MAP env var, extended by reloadSandboxMap() for dynamic users.
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
    const users = JSON.parse(readFileSync("/data/sandbox_users.json", "utf8"));
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
    const users = JSON.parse(readFileSync("/data/sandbox_users.json", "utf8"));
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

// const BASE_SYSTEM = ""; // The system prompt is loaded from /work/.pi/SYSTEM.md.

// Dynamic-only stacks omit OPENCODE_SERVER_URL; every Discord user must be in
// sandbox_users.json (via /sandbox create). Mapped users never use DEFAULT_SERVER.
if (!DEFAULT_SERVER && process.env.PUNCH_REQUIRE_OPENCODE_URL === "1") {
  throw new Error("OPENCODE_SERVER_URL is not set and PUNCH_REQUIRE_OPENCODE_URL=1 (Punch uses dynamic /sandbox create instead)");
}

function headers() {
  const h = { "content-type": "application/json" };
  if (PASS) {
     h.authorization =
        "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
  }
  return h;
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
  for (let attempt = 0; attempt < 4; attempt++) {
     let res;
     try {
        res = await fetch(url, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(body ?? {}),
          signal: signal || AbortSignal.timeout(TIMEOUT_MS),
        });
     } catch (err) {
        if (err.name === "TimeoutError") {
          throw new Error(`pi server timed out after ${TIMEOUT_MS / 1000}s (${srv})`);
        }
        // An externally-supplied signal aborting means the caller gave up
        // (e.g. compress timeout) — don't burn retries, surface it immediately.
        if (err.name === "AbortError" || (signal && signal.aborted)) throw err;
        lastCode = err.cause?.code || err.code || err.message;
        await abortableSleep(2000, signal);
        continue;
      }
       if (!res.ok) {
          const t = await res.text().catch(() => "");
          const transient = res.status >= 500 && /pi not ready|pi not running|pi restarted/i.test(t);
          if (transient && attempt < 3) {
            await abortableSleep(1500, signal);
            continue;
          }
         throw new Error(`pi API ${res.status}: ${t.slice(0, 200)}`);
      }
     return res.json();
  }
  throw new Error(`cannot reach pi server at ${srv} (${lastCode})`);
}

const IDLE_MS = (Number(process.env.OPENCODE_IDLE_TIMEOUT) || 90) * 1000;
const CEIL_MS = (Number(process.env.OPENCODE_MAX) || 1800) * 1000;
const HARD_MS = (Number(process.env.OPENCODE_HARD_TIMEOUT) || 300) * 1000;

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
     res = await fetch(`${srv}/event`, { headers: headers(), signal });
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
            // Includes authoritative session.progress snapshots. Never inspect
            // or log text deltas, tool arguments, or tool outputs here.
            onEvent(ev);
          }
        }
     }
  } catch (err) {
     // stream aborted or errored — fine, we're done
  } finally {
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
  let last = Date.now();
  let lastProgressFingerprint = "";
  const bump = () => { last = Date.now(); };

  let resolveSseReady;
  const sseReady = new Promise((resolve) => { resolveSseReady = resolve; });
  const sseReadyTimer = setTimeout(() => {
    resolveSseReady(false);
    sseAC.abort();
  }, 5000);
  void consumeEvents(sid, sseAC.signal, (ev) => {
    const fingerprint = progressEventFingerprint(ev);
    if (fingerprint == null || fingerprint !== lastProgressFingerprint) {
      bump();
      if (fingerprint != null) lastProgressFingerprint = fingerprint;
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
  const idle = new Promise((_, reject) => {
     idleIv = setInterval(() => {
        if (postAC.signal.aborted) return;
        const now = Date.now();
        if (now - last > idleMs) {
          postAC.abort();
          reject(new Error(`pi stalled: no progress for ${idleMs / 1000}s (session stuck)`));
        } else if (now - start > CEIL_MS) {
          postAC.abort();
          reject(new Error(`pi turn exceeded ${CEIL_MS / 1000}s ceiling`));
        }
     }, 5000);
  });
  const hardDeadline = new Promise((_, reject) => {
     hardTimer = setTimeout(() => {
        postAC.abort();
        sseAC.abort();
        reject(new Error(`pi turn exceeded ${HARD_MS / 1000}s hard timeout`));
     }, HARD_MS);
  });

  const doPost = (async () => {
    // The gateway immediately emits server.connected. Waiting for its headers
    // prevents fast turns from completing before their progress stream exists.
    await sseReady;
    let lastCode;
    for (let attempt = 0; attempt < 4; attempt++) {
      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(body ?? {}),
          signal: postAC.signal,
        });
      } catch (err) {
        if (postAC.signal.aborted) throw err;
        lastCode = err.cause?.code || err.code || err.message;
        bump();
        await abortableSleep(2000, postAC.signal);
        if (postAC.signal.aborted) throw new Error("aborted");
        continue;
      }
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        if (res.status >= 500 && /pi not ready|pi not running|pi restarted/i.test(t) && attempt < 3) {
          bump();
          await abortableSleep(1500, postAC.signal);
          if (postAC.signal.aborted) throw new Error("aborted");
          continue;
        }
        throw new Error(`pi API ${res.status}: ${t.slice(0, 200)}`);
      }
      return res.json();
    }
    throw new Error(`cannot reach pi server at ${srv} (${lastCode})`);
  })();
  doPost.catch(() => {});

  try {
    return await Promise.race([doPost, idle, hardDeadline]);
  } finally {
    clearInterval(idleIv);
    clearTimeout(hardTimer);
    clearTimeout(sseReadyTimer);
    sseAC.abort();
    postAC.abort();
  }
}

// Known model context-window sizes (tokens). Falls back to a conservative
// default when the active model isn't listed. Used only to render a rough
// "how full is the context" indicator — not for any hard enforcement.
const CONTEXT_LIMITS = {
  "anthropic/claude-3-5-sonnet": 200000,
  "anthropic/claude-sonnet-4-5": 200000,
  "anthropic/claude-3-7-sonnet": 200000,
  "openai/gpt-4o": 128000,
  "openai/gpt-4.1": 1000000,
  "google/gemini-2.0-flash": 1000000,
  "google/gemini-2.5-pro": 1000000,
  "opencode/big-pickle": 200000,
  "opencode/deepseek-v4-flash-free": 200000,
  "opencode/mimo-v2.5-free": 200000,
  "opencode/laguna-s-2.1-free": 200000,
  "opencode/north-mini-code-free": 256000,
  "opencode/nemotron-3-ultra-free": 1000000,
};
const DEFAULT_CONTEXT_LIMIT = Number(process.env.OPENCODE_CONTEXT_LIMIT) || 128000;

function contextLimitFor(model) {
  if (!model) return DEFAULT_CONTEXT_LIMIT;
  if (CONTEXT_LIMITS[model]) return CONTEXT_LIMITS[model];
  const [prov] = model.split("/");
  const prefixHit = Object.entries(CONTEXT_LIMITS).find(([k]) => model.startsWith(k) || k.startsWith(model));
  if (prefixHit) return prefixHit[1];
  if (prov === "anthropic") return 200000;
  if (prov === "opencode") return 200000;
  if (prov === "nim") return 131072;
  return DEFAULT_CONTEXT_LIMIT;
}

// Compute the approximate CURRENT context size from an assistant message's
// token usage. `input + cache.read + cache.write` reflects the prompt that was
// sent for this turn (i.e. how full the window is), which is what a user wants
// to see — not the lifetime cumulative counter.
function extractContextUsage(info, model) {
  const t = info?.tokens;
  if (!t) return null;
  const input = Number(t.input) || 0;
  const output = Number(t.output) || 0;
  const reasoning = Number(t.reasoning) || 0;
  const cacheRead = Number(t.cache?.read) || 0;
  const cacheWrite = Number(t.cache?.write) || 0;
  const used = input + cacheRead + cacheWrite;
  const limit = contextLimitFor(model);
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
  const res = await fetch(`${srv}/session/${sid}/message${q}`, { headers: headers() });
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

export async function runAgent(message, sessionId = null, onProgress = null, signal = null, userId = null, attachments = []) {
  const srv = serverFor(userId);
  if (!srv) throw new Error("No sandbox assigned. Ask an admin to create one with /sandbox, or wait for your turn.");
  const dir = userDir(userId);
  let sid = sessionId || (await createSession(userId));
  const q = `?directory=${encodeURIComponent(dir)}`;

  const systemPath = "/work/.pi/SYSTEM.md";
  let sysPrompt = "";
  try {
    const res = await fetch(`${srv}/file/content?path=${encodeURIComponent(systemPath)}&directory=${encodeURIComponent("/work")}`, {
      headers: headers(),
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

  let activeProvider = PROVIDER_ID;
  let activeModel = MODEL_ID;
  const apiUrl = apiUrlFor(userId);
  if (apiUrl) {
    try {
      const res = await fetch(`${apiUrl}/model`, {
        headers: headers(),
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const d = await res.json();
        if (d && d.model) {
          const [p, ...r] = d.model.split("/");
          activeProvider = p;
          activeModel = r.join("/");
        }
      }
    } catch (err) {
      console.error(`[pi] failed to fetch active model from supervisor for ${userId}:`, err.message);
    }
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const parts = [{ type: "text", text: message }];
      // NOTE: gateway message `file` parts reject inline data URLs (HTTP 400),
      // so attachments are delivered out-of-band by the bot (saved into the
      // sandbox workspace and referenced by path in the prompt text). The
      // `attachments` argument is intentionally not inlined here.

      const msg = await postMessageWithIdle(
        sid,
        `/session/${sid}/message${q}`,
        {
          model: { providerID: activeProvider, modelID: activeModel },
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
      const usage = extractContextUsage(msg.info, `${activeProvider}/${activeModel}`);
      const tokenUsage = msg.info?.tokens || null;
      let mediaAttachments = [];
      try {
        mediaAttachments = await collectTurnMedia(sid, userId);
      } catch (err) {
        console.error(`[pi] attachment collect failed:`, err.message);
      }
      return {
        text: out,
        sessionId: sid,
        cost,
        usage,
        tokenUsage,
        activity: msg.info?.activity || null,
        attachments: mediaAttachments,
      };
    } catch (err) {
      if (attempt === 0 && sessionId && /session not found/i.test(err.message)) {
        console.log(`[pi] session ${sid} not found, creating new one`);
        sid = await createSession(userId);
        continue;
      }
      throw err;
    }
  }
}

async function collectTurnMedia(sid, userId) {
  const srv = serverFor(userId);
  if (!srv) return [];
  const dir = userDir(userId);
  const q = `?directory=${encodeURIComponent(dir)}`;
  const res = await fetch(`${srv}/session/${sid}/message${q}`, { headers: headers() });
  if (!res.ok) throw new Error(`getMessages API ${res.status}`);
  const msgs = await res.json();
  console.log(`[attach-debug] collectTurnMedia: ${msgs.length} messages returned`);
  let lastUser = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
     if ((msgs[i].info?.role || msgs[i].role) === "user") { lastUser = i; break; }
  }
  console.log(`[attach-debug] collectTurnMedia: lastUser=${lastUser}`);
  const media = [];
  for (let i = lastUser + 1; i < msgs.length; i++) {
     const parts = msgs[i].parts || [];
     for (const p of parts) {
       if (p.type === "tool" && Array.isArray(p.state?.attachments)) {
         console.log(`[attach-debug]   tool=${p.tool} status=${p.state?.status} attachments=${p.state.attachments.length}`);
       }
     }
     media.push(...extractMediaParts(parts));
  }
  console.log(`[attach-debug] collectTurnMedia: total media=${media.length}`);
  return media;
}

function extractMediaParts(parts) {
  const media = [];
  for (const p of parts || []) {
     if (p.type === "tool" && Array.isArray(p.state?.attachments)) {
        for (const a of p.state.attachments) {
          console.log(`[attach-debug] extractMediaParts: tool=${p.tool} att mime=${a.mime} urlLen=${a?.url?.length || 0}`);
          const buffer = dataUrlToBuffer(a?.url);
          console.log(`[attach-debug] extractMediaParts: buffer=${buffer?.length || "null"}`);
          if (buffer) media.push({ buffer, mime: a.mime, name: mediaName(a.mime, p.tool) });
        }
     } else if ((p.type === "file" || p.type === "image") && typeof p.url === "string") {
        console.log(`[attach-debug] extractMediaParts: ${p.type} mime=${p.mime || p.mimeType} urlLen=${p.url?.length || 0}`);
        const buffer = dataUrlToBuffer(p.url);
        console.log(`[attach-debug] extractMediaParts: buffer=${buffer?.length || "null"}`);
        if (buffer) media.push({ buffer, mime: p.mime || p.mimeType, name: mediaName(p.mime || p.mimeType, p.type) });
     }
  }
  return media;
}

function dataUrlToBuffer(url) {
  if (typeof url !== "string" || !url.startsWith("data:")) return null;
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const meta = url.slice(5, comma);
  if (!/base64/i.test(meta)) return null;
  try {
     return Buffer.from(url.slice(comma + 1), "base64");
  } catch {
     return null;
  }
}

const MIME_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

let mediaSeq = 0;
function mediaName(mime, label) {
  const ext = MIME_EXT[mime] || "png";
  const base = String(label || "attachment").replace(/[^a-z0-9_-]+/gi, "-").slice(0, 32);
  return `${base}-${++mediaSeq}.${ext}`;
}

export async function getFile(filePath, userId) {
  const srv = serverFor(userId);
  const dir = userDir(userId);
  const q = `?path=${encodeURIComponent(filePath)}&directory=${encodeURIComponent(dir)}`;
  const res = await fetch(`${srv}/file/content${q}`, { headers: headers() });
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
         headers: headers(),
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
  const res = await fetch(url, { headers: headers() });
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
     headers: headers(),
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
     headers: headers(),
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
     headers: headers(),
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
     headers: { ...headers(), "Content-Type": "application/json" },
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
  const res = await fetch(url, { headers: headers() });
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
     headers: { ...headers(), "Content-Type": "application/json" },
     body: JSON.stringify({ key, value }),
  });
  if (!res.ok) {
     const t = await res.text().catch(() => "");
     throw new Error(`setEnv API ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

export async function summarizeSession(sessionId, userId, signal = null) {
  const srv = serverFor(userId);
  if (!srv) throw new Error("No sandbox assigned. Ask an admin to create one with /sandbox, or wait for your turn.");
  if (!sessionId) throw new Error("No active session in this channel to compress. Send a message first.");
  const dir = userDir(userId);
  const q = `?directory=${encodeURIComponent(dir)}`;

  let activeProvider = PROVIDER_ID;
  let activeModel = MODEL_ID;
  const apiUrl = apiUrlFor(userId);
  if (apiUrl) {
    try {
      const res = await fetch(`${apiUrl}/model`, {
        headers: headers(),
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const d = await res.json();
        if (d && d.model) {
          const [p, ...r] = d.model.split("/");
          activeProvider = p;
          activeModel = r.join("/");
        }
      }
    } catch (err) {
      console.error(`[pi] failed to fetch active model from supervisor for ${userId}:`, err.message);
    }
  }

  return api(
    `/session/${sessionId}/summarize${q}`,
    { model: { providerID: activeProvider, modelID: activeModel }, providerID: activeProvider, modelID: activeModel },
    srv,
    signal,
  );
}

export async function getEnv(userId) {
  const url = `${apiUrlFor(userId)}/env`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
     const t = await res.text().catch(() => "");
     throw new Error(`getEnv API ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

/** @deprecated use runAgent */
export const runOpencode = runAgent;
