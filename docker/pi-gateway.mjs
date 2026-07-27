#!/usr/bin/env node
// Punch: HTTP adapter on :4096 backed by `pi --mode rpc`.
// Speaks the session/message/SSE subset the Discord bot already uses.
// Subset used by the Discord bot: session, message, event SSE, summarize, abort, file.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { isTurnSettledEvent } from "/usr/local/lib/pi-turn-completion.mjs";
import {
  activityFromProgress,
  closeProgress,
  createProgressState,
  isReportProgressTool,
  progressSnapshot,
  reduceProgress,
  safeToolSsePart,
} from "/usr/local/lib/pi-progress.mjs";

const HOST = process.env.PI_GATEWAY_HOST || "0.0.0.0";
const PORT = Number(process.env.PI_GATEWAY_PORT || 4096);
const WORK = process.env.OPENCODE_REMOTE_DIR || "/work";
const SESSION_DIR = process.env.PI_SESSION_DIR || "/data/pi/sessions";
const SESSION_MAP_FILE =
  process.env.PI_SESSION_MAP || "/data/pi/gateway-sessions.json";
const EXT_DIR = process.env.PI_EXTENSIONS_DIR || "/opt/pi/extensions";
const EXT_DISABLED_FILE = "/data/pi/extensions-disabled.json";
const SKILL_ROOTS = ["/work/.pi/skills", "/data/pi/skills", "/opt/pi/skills"];
const SKILL_ENABLED_FILE = "/data/pi/skills-enabled.json";
const USER = process.env.OPENCODE_SERVER_USERNAME || "opencode";
const PASS = process.env.OPENCODE_SERVER_PASSWORD || "";
let MODEL =
  process.env.OPENCODE_DEFAULT_MODEL ||
  process.env.OPENCODE_MODEL ||
  "anthropic/claude-sonnet-4-5";
const MODEL_FALLBACK = "anthropic/claude-sonnet-4-5";
const MAX_TOOL_STUBS = 40;
let piSpawnedAt = 0;
let usedModelFallback = false;

mkdirSync(SESSION_DIR, { recursive: true });
mkdirSync(join(WORK, ".pi"), { recursive: true });
mkdirSync(dirname(SESSION_MAP_FILE), { recursive: true });

function log(...a) {
  console.log("[pi-gateway]", ...a);
}

function parseModel(m) {
  const s = String(m || MODEL);
  const i = s.indexOf("/");
  if (i < 0) return { provider: s, modelId: s };
  return { provider: s.slice(0, i), modelId: s.slice(i + 1) };
}

function basicOk(req) {
  const expected = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
  return (req.headers.authorization || "") === expected;
}

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolveBody({});
      try {
        resolveBody(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function hashStr(s) {
  return createHash("sha1").update(String(s || "")).digest("hex");
}

function extensionArgs() {
  // Prefer project-local extensions; skip opt copies with the same basename.
  let disabled = {};
  try { disabled = JSON.parse(readFileSync(EXT_DISABLED_FILE, "utf8")); } catch {}
  const args = [];
  const seen = new Set();
  for (const dir of [join(WORK, ".pi", "extensions"), EXT_DIR]) {
    try {
      for (const name of readdirSync(dir)) {
        if (!/\.(ts|js|mjs)$/.test(name)) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        if (disabled[name]) {
          log(`extension disabled: ${join(dir, name)}`);
          continue;
        }
        args.push("-e", join(dir, name));
      }
    } catch {}
  }
  return args;
}

// --- Pi RPC child ----------------------------------------------------------

let child = null;
let stdoutBuf = "";
let ready = false;
let reqSeq = 0;
const pending = new Map();
const sseClients = new Set();
const eventWaiters = new Set();
const reportProgressCalls = new Set();
// Pi RPC has one active agent. Hold session switching and complete prompt lifecycles
// in a FIFO so a second Discord turn cannot collide with an in-flight Pi turn.
let turnChain = Promise.resolve();
function enqueueTurn(work) {
  const previous = turnChain;
  let release;
  const gate = new Promise((resolveGate) => { release = resolveGate; });
  turnChain = previous.catch(() => {}).then(() => gate);
  return previous.catch(() => {}).then(work).finally(release);
}
/** @type {Map<string, { id: string, sessionFile: string|null, systemHash: string|null, messages: any[] }>} */
const sessions = new Map();
const turnProgress = new Map();
let activeLogicalId = null;

function progressEvent(sessionID, properties) {
  return {
    type: "session.progress",
    properties: { sessionID, ...properties },
  };
}

function beginTurnProgress(sessionID) {
  const now = Date.now();
  const state = createProgressState(now);
  reportProgressCalls.clear();
  turnProgress.set(sessionID, state);
  broadcastSse(progressEvent(sessionID, progressSnapshot(state, now)));
}

function trackTurnProgress(sessionID, event) {
  const state = turnProgress.get(sessionID);
  if (!state) return;
  const result = reduceProgress(state, event, Date.now());
  turnProgress.set(sessionID, result.state);
  for (const properties of result.progress) {
    broadcastSse(progressEvent(sessionID, properties));
  }
}

function finishTurnProgress(sessionID, status) {
  const state = turnProgress.get(sessionID);
  if (!state) return;
  const result = closeProgress(state, status, Date.now());
  turnProgress.set(sessionID, result.state);
  for (const properties of result.progress) {
    broadcastSse(progressEvent(sessionID, properties));
  }
}

function turnActivity(sessionID) {
  const state = turnProgress.get(sessionID);
  return state ? activityFromProgress(state, Date.now()) : null;
}

function loadSessionMap() {
  try {
    const raw = JSON.parse(readFileSync(SESSION_MAP_FILE, "utf8"));
    for (const [id, sessionFile] of Object.entries(raw || {})) {
      if (!id || !sessionFile) continue;
      sessions.set(id, {
        id,
        sessionFile: existsSync(sessionFile) ? sessionFile : null,
        systemHash: null,
        messages: [],
      });
    }
    if (sessions.size) log(`restored ${sessions.size} session map entr(ies)`);
  } catch {
    // first boot or corrupt — start empty
  }
}

function persistSessionMap() {
  const out = {};
  for (const [id, s] of sessions) {
    if (s.sessionFile) out[id] = s.sessionFile;
  }
  try {
    writeFileSync(SESSION_MAP_FILE, JSON.stringify(out, null, 2));
  } catch (e) {
    log("persist session map failed:", e.message);
  }
}

function rememberSession(logicalId, sessionFile) {
  let s = sessions.get(logicalId);
  if (!s) {
    s = { id: logicalId, sessionFile: null, systemHash: null, messages: [] };
    sessions.set(logicalId, s);
  }
  if (sessionFile && s.sessionFile !== sessionFile) {
    s.sessionFile = sessionFile;
    persistSessionMap();
  }
  return s;
}

loadSessionMap();

function startPi() {
  if (child) {
    try {
      child.kill("SIGTERM");
    } catch {}
    child = null;
  }
  ready = false;
  stdoutBuf = "";
  for (const [, p] of pending) p.reject(new Error("pi restarted"));
  pending.clear();

  piSpawnedAt = Date.now();
  const { provider, modelId } = parseModel(MODEL);
  const args = [
    "--mode",
    "rpc",
    "--provider",
    provider,
    "--model",
    modelId,
    "--session-dir",
    SESSION_DIR,
    ...extensionArgs(),
  ];
  log("starting: pi", args.join(" "));
  child = spawn("pi", args, {
    cwd: WORK,
    env: {
      ...process.env,
      PI_OFFLINE: process.env.PI_OFFLINE || "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      PI_CODING_AGENT_SESSION_DIR: SESSION_DIR,
    },
    stdio: ["pipe", "pipe", "inherit"],
  });

  child.stdout.on("data", onStdout);
  child.on("exit", (code, signal) => {
    const uptime = Date.now() - piSpawnedAt;
    log(`pi exited code=${code} signal=${signal}`);
    ready = false;
    child = null;
    for (const [, p] of pending) p.reject(new Error("pi exited"));
    pending.clear();
    if (activeLogicalId) finishTurnProgress(activeLogicalId, "error");
    // Unknown / bad provider exits immediately — fall back so health/session work.
    if (
      code &&
      code !== 0 &&
      uptime < 5000 &&
      !usedModelFallback &&
      MODEL !== MODEL_FALLBACK
    ) {
      usedModelFallback = true;
      log(`pi failed fast with model ${MODEL}; falling back to ${MODEL_FALLBACK}`);
      MODEL = MODEL_FALLBACK;
    }
    setTimeout(startPi, 1000);
  });
}

function onStdout(chunk) {
  stdoutBuf += chunk.toString("utf8");
  let idx;
  while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
    let line = stdoutBuf.slice(0, idx);
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log("non-json stdout:", line.slice(0, 200));
      continue;
    }
    dispatchPi(msg);
  }
}

function dispatchPi(msg) {
  if (msg?.type === "ready") {
    ready = true;
    log("pi ready");
    return;
  }
  if (msg?.type === "response" && msg.id != null && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.success === false) {
      p.reject(new Error(msg.error || `${msg.command} failed`));
    } else {
      // Any successful RPC proves the process is up (Pi may omit the ready frame).
      ready = true;
      p.resolve(msg);
    }
  } else {
    if (activeLogicalId) trackTurnProgress(activeLogicalId, msg);
    broadcastSse(piEventToOpenCode(msg));
    if (activeLogicalId && sessions.has(activeLogicalId)) {
      trackMessageCache(activeLogicalId, msg);
    }
  }
  for (const w of eventWaiters) {
    try {
      w(msg);
    } catch {}
  }
}

function rpc(type, fields = {}, timeoutMs = 120000) {
  return new Promise((resolveP, rejectP) => {
    if (!child || !child.stdin.writable) {
      rejectP(new Error("pi not running"));
      return;
    }
    const id = `r${++reqSeq}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectP(new Error(`pi rpc ${type} timed out`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolveP(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        rejectP(e);
      },
    });
    child.stdin.write(JSON.stringify({ id, type, ...fields }) + "\n");
  });
}

async function waitReady(ms = 45000) {
  const start = Date.now();
  while (!ready) {
    if (Date.now() - start > ms) throw new Error("pi not ready");
    if (child?.stdin?.writable) {
      try {
        await rpc("get_state", {}, 4000);
        // dispatchPi sets ready on success; belt-and-suspenders:
        ready = true;
        log("pi ready (via get_state)");
        return;
      } catch {
        // keep trying until timeout
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function ensureSession(logicalId) {
  let s = sessions.get(logicalId);
  if (!s) {
    s = { id: logicalId, sessionFile: null, systemHash: null, messages: [] };
    sessions.set(logicalId, s);
  }
  await waitReady();
  if (activeLogicalId !== logicalId) {
    if (s.sessionFile && existsSync(s.sessionFile)) {
      await rpc("switch_session", { sessionPath: s.sessionFile });
    } else {
      await rpc("new_session");
      const st = await rpc("get_state");
      rememberSession(logicalId, st.data?.sessionFile || null);
    }
    activeLogicalId = logicalId;
  } else if (!s.sessionFile) {
    const st = await rpc("get_state");
    rememberSession(logicalId, st.data?.sessionFile || null);
  }
  return s;
}

function enabledSkillInstructions() {
  let enabled = {};
  try { enabled = JSON.parse(readFileSync(SKILL_ENABLED_FILE, "utf8")); } catch {}
  const seen = new Set();
  const sections = [];
  for (const root of SKILL_ROOTS) {
    let names = [];
    try { names = readdirSync(root); } catch { continue; }
    for (const name of names) {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name) || seen.has(name) || enabled[name] === false) continue;
      try {
        const text = readFileSync(join(root, name, "SKILL.md"), "utf8");
        seen.add(name);
        const body = text.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "").trim();
        if (body) sections.push(`<skill name="${name}">\n${body.slice(0, 12000)}\n</skill>`);
      } catch {}
    }
  }
  return sections.length ? `\n\n--- Enabled instruction skills ---\n${sections.join("\n\n")}\n--- End instruction skills ---` : "";
}

function buildUserPrompt(session, text, system) {
  const enrichedSystem = `${system || ""}${enabledSkillInstructions()}`;
  const h = enrichedSystem ? hashStr(enrichedSystem) : null;
  if (enrichedSystem && h !== session.systemHash) {
    session.systemHash = h;
    return `<punch-system>\n${enrichedSystem}\n</punch-system>\n\n${String(text || "")}`;
  }
  return String(text || "");
}

function extractTextFromParts(parts) {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p) => p && (p.type === "text" || p.type === "input_text") && p.text)
    .map((p) => p.text)
    .join("");
}

/** OpenCode-shaped attachments (data URLs) for bot collectTurnMedia. */
function attachmentsFromToolResult(result) {
  const out = [];
  const content = result?.content;
  if (!Array.isArray(content)) {
    log(`[attach-debug] result has no content array, typeof result=${typeof result}, keys=${result && typeof result === "object" ? Object.keys(result).join(",") : "n/a"}`);
    return out;
  }
  log(`[attach-debug] result.content has ${content.length} parts: ${content.map((p) => `${p?.type}:${p?.mimeType || p?.mime || "?"}:${typeof p?.data === "string" ? p.data.length : "no-data"}len`).join(", ")}`);
  for (const part of content) {
    if (!part || part.type !== "image") continue;
    const data = typeof part.data === "string" ? part.data : "";
    if (!data) continue;
    const mime = part.mimeType || part.mime || "image/png";
    out.push({ mime, url: `data:${mime};base64,${data}` });
  }
  return out;
}

/** Compact private tool output for the final-response fallback; omit image data. */
function textOutputFromToolResult(result) {
  if (typeof result === "string") return result;
  if (Array.isArray(result?.content)) {
    const texts = result.content
      .filter((part) => part?.type === "text" && part.text)
      .map((part) => part.text);
    const imageCount = result.content.filter((part) => part?.type === "image").length;
    let text = texts.join("\n");
    if (imageCount) text += `${text ? "\n" : ""}[${imageCount} image attachment(s)]`;
    if (text) return text;
  }
  return JSON.stringify(result ?? "");
}

function assistantFromPiMessages(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    const role = m.role || m.info?.role;
    if (role !== "assistant") continue;
    let text = "";
    if (typeof m.content === "string") text = m.content;
    else if (Array.isArray(m.content)) text = extractTextFromParts(m.content);
    else if (Array.isArray(m.parts)) text = extractTextFromParts(m.parts);
    const stop = m.stopReason || m.stop_reason || "";
    const err =
      stop === "error" || stop === "aborted"
        ? { name: stop, message: m.errorMessage || m.error || stop }
        : null;
    const usage = m.usage || {};
    const { provider, modelId } = parseModel(MODEL);
    return {
      info: {
        role: "assistant",
        cost: Number(usage.cost) || 0,
        tokens: {
          input: Number(usage.input) || Number(usage.inputTokens) || 0,
          output: Number(usage.output) || Number(usage.outputTokens) || 0,
          reasoning: Number(usage.reasoning) || 0,
          cache: {
            read: Number(usage.cacheRead) || 0,
            write: Number(usage.cacheWrite) || 0,
          },
        },
        providerID: m.provider || provider,
        modelID: m.model || modelId,
        error: err,
      },
      parts: text ? [{ type: "text", text }] : [],
    };
  }
  return {
    info: { role: "assistant", cost: 0, tokens: { input: 0, output: 0 } },
    parts: [],
  };
}

function trimToolStubs(s) {
  if (!s?.messages?.length) return;
  const toolIdx = [];
  for (let i = 0; i < s.messages.length; i++) {
    if ((s.messages[i].parts || []).some((p) => p.type === "tool")) toolIdx.push(i);
  }
  if (toolIdx.length <= MAX_TOOL_STUBS) return;
  const drop = new Set(toolIdx.slice(0, toolIdx.length - MAX_TOOL_STUBS));
  s.messages = s.messages.filter((_, i) => !drop.has(i));
}

function trackMessageCache(logicalId, ev) {
  const s = sessions.get(logicalId);
  if (!s) return;
  if (ev?.type === "tool_execution_start") {
    if (isReportProgressTool(ev)) return;
    const callID = ev.toolCallId || randomUUID();
    s.messages.push({
      info: { role: "assistant" },
      parts: [safeToolSsePart(ev, callID, "running")],
    });
    trimToolStubs(s);
  } else if (ev?.type === "tool_execution_end") {
    if (isReportProgressTool(ev)) return;
    const last = s.messages[s.messages.length - 1];
    const part = last?.parts?.find(
      (p) => p.type === "tool" && p.callID === ev.toolCallId,
    );
    log(`[attach-debug] tool_execution_end: toolCallId=${ev.toolCallId}, result type=${typeof ev.result}, hasResult=${ev.result != null}, partFound=${part != null}, tool=${part?.tool}`);
    if (part) {
      const attachments = attachmentsFromToolResult(ev.result);
      log(`[attach-debug] tool_execution_end: attachments count=${attachments.length}, tool=${part.tool}`);
      part.state = {
        status: ev.isError ? "error" : "done",
        title: part.state?.title,
        input: part.state?.input,
        output: textOutputFromToolResult(ev.result ?? ev.error ?? ""),
        ...(attachments.length ? { attachments } : {}),
      };
    }
  }
}

function piEventToOpenCode(ev) {
  const sid = activeLogicalId || "unknown";
  if (!ev || !ev.type) return null;

  if (ev.type === "message_update") {
    const a = ev.assistantMessageEvent || {};
    if (a.type === "text_delta" && a.delta) {
      return {
        type: "message.part.delta",
        properties: { sessionID: sid, delta: { text: a.delta } },
      };
    }
    return null;
  }

  if (ev.type === "tool_execution_start") {
    const callID = ev.toolCallId || randomUUID();
    if (isReportProgressTool(ev)) {
      reportProgressCalls.add(callID);
      return null;
    }
    return {
      type: "message.part.updated",
      properties: {
        sessionID: sid,
        part: safeToolSsePart(ev, callID, "running"),
      },
    };
  }

  if (ev.type === "tool_execution_end") {
    const callID = ev.toolCallId || randomUUID();
    if (isReportProgressTool(ev) || reportProgressCalls.delete(callID)) return null;
    return {
      type: "message.part.updated",
      properties: {
        sessionID: sid,
        part: safeToolSsePart(
          ev,
          callID,
          ev.isError ? "error" : "done",
        ),
      },
    };
  }

  if (isTurnSettledEvent(ev)) {
    return { type: "session.idle", properties: { sessionID: sid } };
  }

  if (ev.type === "agent_start") {
    return {
      type: "session.status",
      properties: { sessionID: sid, status: "busy" },
    };
  }

  return null;
}

function broadcastSse(ocEvent) {
  if (!ocEvent) return;
  const frame = `data: ${JSON.stringify(ocEvent)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
}

/**
 * Wait until agent_settled after a prompt.
 * Caller must register this BEFORE rpc("prompt") so settled cannot be missed.
 * Other lifecycle events are not terminal: Pi can report idle between tool calls.
 * Returns a promise with .cancel(err) to detach early on prompt failure.
 */
function waitTurn(signal) {
  let cancel = () => {};
  const promise = new Promise((resolveP, rejectP) => {
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      eventWaiters.delete(onEvent);
      if (signal) signal.removeEventListener("abort", onAbort);
      fn(arg);
    };

    cancel = (err) => {
      finish(rejectP, err || new Error("waitTurn cancelled"));
    };

    const onAbort = () => {
      rpc("abort").catch(() => {});
      finish(rejectP, Object.assign(new Error("aborted"), { name: "AbortError" }));
    };

    const onEvent = (msg) => {
      if (!msg?.type) return;
      if (isTurnSettledEvent(msg)) {
        finish(resolveP);
      }
    };

    // Attach waiter first — before any await — so events during prompt are caught.
    eventWaiters.add(onEvent);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort);
    }
  });
  promise.cancel = cancel;
  return promise;
}

function safePath(p) {
  const abs =
    p.startsWith("/work") || p.startsWith("/data") || p.startsWith("/tmp")
      ? resolve(p)
      : resolve(WORK, p);
  const roots = [resolve(WORK), resolve("/data"), resolve("/tmp")];
  const ok = roots.some((root) => abs === root || abs.startsWith(root + "/"));
  if (!ok) throw new Error("path outside sandbox");
  return abs;
}

/** Register turn waiter, then prompt — avoids missing agent_settled. */
async function promptAndWait(promptText, signal) {
  if (signal?.aborted) {
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  }
  const turnP = waitTurn(signal);
  try {
    await rpc("prompt", { message: promptText, streamingBehavior: "followUp" }, 60000);
  } catch (e) {
    turnP.cancel(e);
    await turnP.catch(() => {});
    throw e;
  }
  await turnP;
}

// --- HTTP ------------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (!basicOk(req) && url.pathname !== "/health") {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Pi Gateway"' });
    res.end("Unauthorized");
    return;
  }

  try {
    if (
      req.method === "GET" &&
      (url.pathname === "/health" || url.pathname === "/experimental/tool/ids")
    ) {
      if (!ready && child?.stdin?.writable) {
        try {
          await rpc("get_state", {}, 5000);
          ready = true;
        } catch {}
      }
      json(res, ready ? 200 : 503, {
        ok: ready,
        tools: ["bash", "read", "write", "edit"],
      });
      return;
    }

    if (
      req.method === "GET" &&
      (url.pathname === "/event" || url.pathname === "/global/event")
    ) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(
        `data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`,
      );
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    if (req.method === "POST" && url.pathname === "/session") {
      await waitReady();
      const id = randomUUID();
      await rpc("new_session");
      const st = await rpc("get_state");
      sessions.set(id, {
        id,
        sessionFile: st.data?.sessionFile || null,
        systemHash: null,
        messages: [],
      });
      if (st.data?.sessionFile) persistSessionMap();
      activeLogicalId = id;
      broadcastSse({
        type: "session.created",
        properties: { sessionID: id, info: { id } },
      });
      json(res, 200, { id, title: "", time: { created: Date.now() } });
      return;
    }

    if (req.method === "POST" && url.pathname === "/abort") {
      // Fire-and-forget: don't await Pi RPC response — it may hang if Pi is stuck.
      rpc("abort", {}, 5000).catch(() => {});
      if (activeLogicalId) finishTurnProgress(activeLogicalId, "aborted");
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/session") {
      json(
        res,
        200,
        [...sessions.values()].map((s) => ({ id: s.id, title: "" })),
      );
      return;
    }

    const sessMatch = url.pathname.match(
      /^\/session\/([^/]+)(?:\/(message|summarize|abort|prompt_async))?$/,
    );
    if (sessMatch) {
      const sid = decodeURIComponent(sessMatch[1]);
      const action = sessMatch[2] || "";

      if (req.method === "GET" && action === "message") {
        const s = sessions.get(sid);
        if (!s) {
          json(res, 404, { error: "session not found" });
          return;
        }
        try {
          await ensureSession(sid);
          const gm = await rpc("get_messages");
          const mapped = (gm.data?.messages || []).map((m) => {
            const role = m.role || "user";
            let text = "";
            if (typeof m.content === "string") text = m.content;
            else if (Array.isArray(m.content))
              text = extractTextFromParts(m.content);
            return {
              info: { role, id: m.id || randomUUID() },
              parts: text ? [{ type: "text", text }] : [],
            };
          });
          // Append cached tool parts from this gateway turn for media scrape
          const toolParts = s.messages.filter((m) =>
            (m.parts || []).some((p) => p.type === "tool"),
          );
          log(`[attach-debug] GET messages: mapped=${mapped.length}, cached=${s.messages.length}, toolParts=${toolParts.length}`);
          for (const tp of toolParts) {
            for (const p of tp.parts || []) {
              if (p.type === "tool") {
                const attCount = Array.isArray(p.state?.attachments) ? p.state.attachments.length : 0;
                log(`[attach-debug]   tool=${p.tool} status=${p.state?.status} attachments=${attCount}`);
              }
            }
          }
          const withTools = mapped.concat(toolParts);
          json(res, 200, withTools.length ? withTools : s.messages);
        } catch {
          json(res, 200, s.messages || []);
        }
        return;
      }

      if (req.method === "POST" && action === "abort") {
        await rpc("abort").catch(() => {});
        finishTurnProgress(sid, "aborted");
        json(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && action === "summarize") {
        // Recreate mapping after gateway restart (same as message path)
        if (!sessions.has(sid)) {
          sessions.set(sid, {
            id: sid,
            sessionFile: null,
            systemHash: null,
            messages: [],
          });
        }
        await ensureSession(sid);
        const body = await readBody(req).catch(() => ({}));
        const providerID = body?.model?.providerID || body?.providerID;
        const modelID = body?.model?.modelID || body?.modelID;
        if (providerID && modelID) {
          await rpc("set_model", {
            provider: providerID,
            modelId: modelID,
          }).catch(() => {});
        }
        await rpc("compact", {}, 300000);
        json(res, 200, { ok: true });
        return;
      }

      if (
        req.method === "POST" &&
        (action === "message" || action === "prompt_async")
      ) {
        if (!sessions.has(sid)) {
          sessions.set(sid, {
            id: sid,
            sessionFile: null,
            systemHash: null,
            messages: [],
          });
        }
        const body = await readBody(req);
        const textPart = (body.parts || []).find((p) => p.type === "text");
        const userText = textPart?.text || "";
        const system = body.system || "";
        const model = body.model;

        const ac = new AbortController();
        const onClose = () => ac.abort();
        req.on("close", onClose);

        try {
          await enqueueTurn(async () => {
            const session = await ensureSession(sid);
            beginTurnProgress(sid);
            try {
              if (model?.providerID && model?.modelID) {
                await rpc("set_model", {
                  provider: model.providerID,
                  modelId: model.modelID,
                }).catch((e) => log("set_model:", e.message));
              }

              const promptText = buildUserPrompt(session, userText, system);
              session.messages.push({
                info: { role: "user" },
                parts: [{ type: "text", text: userText }],
              });

              await promptAndWait(promptText, ac.signal);

              const gm = await rpc("get_messages");
              const assistant = assistantFromPiMessages(gm.data?.messages || []);
              finishTurnProgress(sid, assistant.info.error ? "error" : "completed");
              assistant.info.activity = turnActivity(sid);
              session.messages.push(assistant);
              // Keep recent tool stubs for post-turn media scrape; bound growth
              trimToolStubs(session);

              if (action === "prompt_async") json(res, 200, { ok: true });
              else json(res, 200, assistant);
            } catch (e) {
              finishTurnProgress(
                sid,
                e.name === "AbortError" || ac.signal.aborted ? "aborted" : "error",
              );
              throw e;
            } finally {
              turnProgress.delete(sid);
            }
          });
        } catch (e) {
          if (e.name === "AbortError" || ac.signal.aborted) {
            await rpc("abort").catch(() => {});
            json(res, 499, { error: "aborted" });
          } else {
            log("message error:", e.message);
            json(res, 500, { error: e.message });
          }
        } finally {
          req.off("close", onClose);
        }
        return;
      }

      if (req.method === "GET" && !action) {
        if (!sessions.has(sid)) {
          json(res, 404, { error: "session not found" });
          return;
        }
        json(res, 200, { id: sid, title: "", time: { created: Date.now() } });
        return;
      }

      if (req.method === "DELETE" && !action) {
        sessions.delete(sid);
        if (activeLogicalId === sid) activeLogicalId = null;
        persistSessionMap();
        json(res, 200, { ok: true });
        return;
      }
    }

    if (req.method === "GET" && url.pathname === "/file/content") {
      const p = url.searchParams.get("path");
      if (!p) {
        json(res, 400, { error: "missing path" });
        return;
      }
      try {
        const abs = safePath(p);
        const buf = readFileSync(abs);
        const isText = !buf.includes(0);
        if (isText) json(res, 200, { type: "text", content: buf.toString("utf8") });
        else
          json(res, 200, { type: "binary", content: buf.toString("base64") });
      } catch (e) {
        json(res, 404, { error: e.message });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/file") {
      const p = url.searchParams.get("path") || ".";
      try {
        const abs = safePath(p);
        const entries = readdirSync(abs).map((name) => {
          const st = statSync(join(abs, name));
          return {
            name,
            type: st.isDirectory() ? "directory" : "file",
            size: st.size,
          };
        });
        json(res, 200, entries);
      } catch (e) {
        json(res, 404, { error: e.message });
      }
      return;
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    log("handler error:", e.message);
    json(res, 500, { error: e.message });
  }
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    if (child) child.kill(sig);
    process.exit(0);
  });
}

startPi();
server.listen(PORT, HOST, () => {
  log(`listening on ${HOST}:${PORT} (model ${MODEL})`);
});
