// Sandbox entrypoint. Runs Punch's pi-gateway (HTTP on :4096
// over `pi --mode rpc`) and exposes the supervisor API on :4097.
//
// Self-extension: when the LLM writes a Pi extension into /work/.pi/extensions/,
// this supervisor restarts the gateway so new tools register. Pi loads -e
// extensions at process start. Legacy /work/.opencode/tools are NOT loaded into Pi.
//
// Sessions persist under /data/pi/sessions. Quarantine: after restart we health-
// probe the gateway; on persistent failure we move the newest extension into
// .broken/ and reload.

import { spawn, exec, execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, watch, writeFileSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import { resolvePeerSandbox } from "/usr/local/lib/pigeon-peer.js";
import { repairSandboxDoctor, runSandboxDoctor } from "/usr/local/lib/doctor.mjs";
import { inspectSkill, listProposals, listSkills, proposeSkill, reviewProposal, setSkillEnabled } from "/usr/local/lib/skills-manager.mjs";
import { getWorkerSettings, listWorkers, setWorkerCap, startWorker, stopWorker, workerLogs } from "/usr/local/lib/worker-manager.mjs";

// Pi-only extension dirs (watched for reload / listed by /tools).
const TOOL_DIRS = [
  "/work/.pi/extensions",
];

// Legacy wire-auth username for supervisor/gateway HTTP. Sandboxes historically
// only received OPENCODE_SERVER_PASSWORD; ensure the username is visible to Pi
// bash (`$OPENCODE_SERVER_USERNAME`) so BASE_SYSTEM curl examples authenticate.
if (!process.env.OPENCODE_SERVER_USERNAME) {
  process.env.OPENCODE_SERVER_USERNAME = "opencode";
}

/** Parse POST body for /tasks/run and /tasks/exec. Accepts JSON or form fields. */
function parseTaskBody(raw, contentType = "") {
  const body = String(raw ?? "");
  const trimmed = body.trim();
  if (!trimmed) {
    throw new Error('Empty body — send JSON {"command":"..."} with content-type application/json');
  }
  const ct = String(contentType || "").toLowerCase();

  const fromObj = (obj) => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      throw new Error('Body must be an object with a string "command" field');
    }
    const command = obj.command;
    if (typeof command !== "string" || !command.trim()) {
      throw new Error('Missing command — expected {"command":"shell command here"}');
    }
    const out = { command };
    if (obj.timeout != null && obj.timeout !== "") {
      const timeout = Number(obj.timeout);
      if (Number.isFinite(timeout) && timeout > 0) out.timeout = timeout;
    }
    return out;
  };

  if (ct.includes("application/x-www-form-urlencoded") || (!trimmed.startsWith("{") && /(?:^|&)command=/.test(trimmed))) {
    const params = new URLSearchParams(trimmed);
    return fromObj({
      command: params.get("command"),
      timeout: params.get("timeout"),
    });
  }

  if (ct.includes("text/plain") && !trimmed.startsWith("{")) {
    return fromObj({ command: trimmed });
  }

  try {
    return fromObj(JSON.parse(trimmed));
  } catch (err) {
    if (err && /Missing command|must be an object|Empty body/.test(String(err.message))) throw err;
    throw new Error(
      'Invalid JSON — body must be {"command":"..."} (for complex commands, write a script file under /work then pass command:"python3 /work/script.py")',
    );
  }
}

// --- Model configuration ---
const MODEL_FILE = "/data/model.json";
const MODEL_DEFAULT = "opencode/big-pickle";
/** Legacy OpenCode / Discord ids → Pi-capable provider/model strings. */
const MODEL_ALIASES = {
  "anthropic/claude-sonnet-4-5": MODEL_DEFAULT,
  "poolside/poolside/laguna-xs.2": "poolside/poolside/laguna-xs-2.1",
  "poolside/laguna-xs.2": "poolside/poolside/laguna-xs-2.1",
};

function normalizeModel(model) {
  const s = String(model || "").trim();
  if (!s) return MODEL_DEFAULT;
  return MODEL_ALIASES[s] || s;
}

function loadModel() {
  try { const v = JSON.parse(readFileSync(MODEL_FILE, "utf8")).model; return v || null; }
  catch { return null; }
}
function saveModel(model) {
  writeFileSync(MODEL_FILE, JSON.stringify({ model }));
}
// Use saved model if it exists, otherwise fall back to process.argv[2] or default
const saved = loadModel();
let CURRENT_MODEL;
if (saved) {
  CURRENT_MODEL = normalizeModel(saved);
  if (CURRENT_MODEL !== saved) {
    saveModel(CURRENT_MODEL);
    console.log("[supervisor] normalized model", saved, "->", CURRENT_MODEL);
  }
} else {
  CURRENT_MODEL = normalizeModel(process.argv[2] || MODEL_DEFAULT);
  saveModel(CURRENT_MODEL);
}
// pi-gateway / Pi RPC pick up model from this env var
process.env.OPENCODE_DEFAULT_MODEL = CURRENT_MODEL;
process.env.OPENCODE_MODEL = CURRENT_MODEL;

const DEBOUNCE_MS = 3000;
const HEALTHY_MS = 8000;

const WORK = "/work";
const PROBE_URL = `http://127.0.0.1:4096/health`;
const PROBE_AUTH =
  "Basic " +
  Buffer.from(
    `${process.env.OPENCODE_SERVER_USERNAME || "opencode"}:${process.env.OPENCODE_SERVER_PASSWORD || ""}`,
  ).toString("base64");
const EXT_DISABLED_FILE = "/data/pi/extensions-disabled.json";

for (const d of TOOL_DIRS) mkdirSync(join(d, ".broken"), { recursive: true });
mkdirSync("/data/pi/sessions", { recursive: true });
mkdirSync("/data/pi/agent", { recursive: true });

let child = null;
let startedAt = 0;
let reloadTimer = null;
let restarting = false;
let generation = 0;
let loadedHash = "";
let armedForQuarantine = false;

function log(...a) {
  console.log("[supervisor]", ...a);
}

function toolFiles() {
  const files = [];
  for (const dir of TOOL_DIRS) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name === ".broken") continue;
      if (!/\.(ts|js|mjs|cjs)$/.test(name)) continue;
      const full = join(dir, name);
      try {
        files.push({ dir, name, full, mtime: statSync(full).mtimeMs });
      } catch {
        // raced deletion
      }
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime);
}

function toolSetHash() {
  const h = createHash("sha1");
  for (const f of toolFiles().sort((a, b) => a.full.localeCompare(b.full))) {
    try {
      h.update(f.full).update("\0").update(readFileSync(f.full));
    } catch {
      // raced deletion
    }
  }
  return h.digest("hex");
}

function quarantineNewest() {
  const [newest] = toolFiles();
  if (!newest) {
    log("nothing to quarantine (no tool files); serve keeps failing on its own");
    return false;
  }
  const dest = join(newest.dir, ".broken", newest.name);
  try {
    renameSync(newest.full, dest);
    log(`quarantined bad tool -> ${dest}`);
    return true;
  } catch (e) {
    log("quarantine failed:", e.message);
    return false;
  }
}

function start() {
  restarting = false;
  startedAt = Date.now();
  const gen = ++generation;
  loadedHash = toolSetHash();
  log("starting: pi-gateway (model", CURRENT_MODEL + ")");
  const gatewayEnv = { ...process.env };
  delete gatewayEnv.PUNCH_DOCTOR_TOKEN;
  child = spawn("node", ["/usr/local/bin/pi-gateway.mjs"], {
    stdio: "inherit",
    env: {
      ...gatewayEnv,
      OPENCODE_DEFAULT_MODEL: CURRENT_MODEL,
      OPENCODE_MODEL: CURRENT_MODEL,
      PI_EXTENSIONS_DIR: "/opt/pi/extensions",
      PI_SESSION_DIR: "/data/pi/sessions",
      OPENCODE_REMOTE_DIR: WORK,
    },
  });

  const spawnedChild = child;
  spawnedChild.on("exit", (code, signal) => {
    const uptime = Date.now() - startedAt;
    log(`pi-gateway exited code=${code} signal=${signal} uptime=${uptime}ms`);
    if (child === spawnedChild) child = null;

    if (restarting) return;

    if (armedForQuarantine && uptime < HEALTHY_MS) {
      armedForQuarantine = false;
      quarantineNewest();
    }
    setTimeout(start, 1000);
  });

  probeHealth(gen);
}

async function probeHealth(gen) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (gen !== generation) return;
    let status;
    try {
      const res = await fetch(PROBE_URL, { headers: { authorization: PROBE_AUTH } });
      status = res.status;
    } catch {
      await sleep(500);
      continue;
    }
    if (gen !== generation) return;
    if (status === 500) {
      log("health probe 500 -> tool set is poisoned");
      armedForQuarantine = false;
      if (quarantineNewest()) forceRestart();
      else log("could not quarantine; leaving gateway up (may keep 500ing)");
      return;
    }
    if (status !== 200) {
      await sleep(500);
      continue;
    }
    armedForQuarantine = false;
    log(`health probe ${status} -> gateway OK`);
    return;
  }
  log("health probe timed out waiting for serve");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function forceRestart() {
  if (restarting) return;
  if (!child) {
    start();
    return;
  }
  restarting = true;
  const dying = child;
  dying.once("exit", start);
  dying.kill("SIGTERM");
  setTimeout(() => {
    try { dying.kill("SIGKILL"); } catch {}
  }, 4000);
}

function restartForReload() {
  if (!child || restarting) return;

  if (toolSetHash() === loadedHash) {
    log("watch fired but tool content unchanged -> skip reload");
    return;
  }
  restarting = true;
  armedForQuarantine = true;
  log("extension/tool change detected -> reloading pi-gateway");
  const dying = child;
  dying.once("exit", start);
  dying.kill("SIGTERM");
  setTimeout(() => { try { dying.kill("SIGKILL"); } catch {} }, 4000);
}

function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(restartForReload, DEBOUNCE_MS);
}

for (const dir of TOOL_DIRS) {
  watch(dir, (_event, filename) => {
    if (!filename) return;
    if (String(filename).startsWith(".broken")) return;
    if (!/\.(ts|js|mjs|cjs)$/.test(filename)) return;
    log(`change: ${dir}/${filename}`);
    scheduleReload();
  });
}

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    log(`got ${sig}, shutting down`);
    restarting = true;
    if (child) child.kill(sig);
    process.exit(0);
  });
}

// --- Env / secrets storage (per-container, so no user prefix needed) ---
const ENV_FILE = "/data/env.json";
const SECRETS_FILE = "/data/secrets.json";
// Pi reads auth from $PI_CODING_AGENT_DIR/auth.json (see sandbox.Dockerfile).
const AUTH_FILE = join(
  process.env.PI_CODING_AGENT_DIR || "/data/pi/agent",
  "auth.json",
);
const MODELS_FILE = join(
  process.env.PI_CODING_AGENT_DIR || "/data/pi/agent",
  "models.json",
);
const MCP_FILE = "/data/mcp.json";

/** Seed OpenAI-compatible providers Pi does not ship (e.g. Poolside).
 * OpenCode Zen is NOT here — Pi ships a native `opencode` provider with
 * correct compat flags (supportsDeveloperRole, maxTokensField, etc.).
 * Overriding it stripped those flags and broke tool calling. */
const BUILTIN_CUSTOM_PROVIDERS = {
  poolside: {
    baseUrl: "https://inference.poolside.ai/v1",
    api: "openai-completions",
    apiKey: "$POOLSIDE_API_KEY",
    models: [
      {
        id: "poolside/laguna-m.1",
        name: "Laguna M.1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 32768,
      },
      {
        id: "poolside/laguna-xs-2.1",
        name: "Laguna XS 2.1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 32768,
      },
      {
        id: "poolside/laguna-s-2.1",
        name: "Laguna S 2.1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 32768,
      },
      // legacy Discord / OpenCode model id
      {
        id: "poolside/laguna-xs.2",
        name: "Laguna XS (legacy id)",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 32768,
      },
    ],
  },
};

// Providers we used to override but removed so Pi's native (better) config wins.
// Clean stale entries from models.json so the native provider isn't shadowed.
const FORMERLY_OVERRIDDEN_PROVIDERS = new Set(["opencode"]);

function ensurePiModelsJson() {
  mkdirSync(dirname(MODELS_FILE), { recursive: true });
  const existing = loadJSON(MODELS_FILE);
  if (!existing.providers || typeof existing.providers !== "object") {
    existing.providers = {};
  }
  let changed = false;
  // Remove stale providers that Pi now ships natively.
  for (const id of FORMERLY_OVERRIDDEN_PROVIDERS) {
    if (existing.providers[id] && !BUILTIN_CUSTOM_PROVIDERS[id]) {
      delete existing.providers[id];
      changed = true;
      log("removed stale custom provider", id, "(using Pi native)");
    }
  }
  for (const [id, cfg] of Object.entries(BUILTIN_CUSTOM_PROVIDERS)) {
    const prev = existing.providers[id];
    const next = { ...cfg };
    // Preserve user overrides for baseUrl / models if already customized.
    if (prev?.baseUrl && prev.baseUrl !== cfg.baseUrl) next.baseUrl = prev.baseUrl;
    if (Array.isArray(prev?.models) && prev.models.length) {
      const byId = new Map(cfg.models.map((m) => [m.id, { ...m }]));
      for (const m of prev.models) {
        if (m?.id) byId.set(m.id, { ...(byId.get(m.id) || {}), ...m });
      }
      next.models = [...byId.values()];
    }
    const same = JSON.stringify(prev) === JSON.stringify(next);
    if (!same) {
      existing.providers[id] = next;
      changed = true;
    }
  }
  if (changed || !existsSync(MODELS_FILE)) {
    saveJSON(MODELS_FILE, existing);
    log("ensured Pi models.json custom providers:", Object.keys(BUILTIN_CUSTOM_PROVIDERS).join(", "));
  }
}

const PROVIDER_ENV_MAP = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  google: "GOOGLE_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  groq: "GROQ_API_KEY",
  together: "TOGETHER_API_KEY",
  poolside: "POOLSIDE_API_KEY",
  opencode: "OPENCODE_API_KEY",
};

function loadJSON(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch { return {}; }
}
function saveJSON(file, obj) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2));
}

/** Pi auth shape: { type: "api_key", key } under provider id. */
function syncAuthProvider(provider, key) {
  const id = provider.toLowerCase();
  const auth = loadJSON(AUTH_FILE);
  if (key) {
    auth[id] = { type: "api_key", key };
  } else {
    delete auth[id];
  }
  saveJSON(AUTH_FILE, auth);
}

/** Pi Google provider expects GEMINI_API_KEY; keep GOOGLE_API_KEY for compat. */
function mirrorGoogleGemini(env, key) {
  if (key) {
    env.GEMINI_API_KEY = key;
    process.env.GEMINI_API_KEY = key;
  } else {
    delete env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
  }
}

function syncEnvApiKeysToAuth() {
  const env = loadJSON(ENV_FILE);
  const auth = loadJSON(AUTH_FILE);
  let changed = false;
  for (const [provider, envVar] of Object.entries(PROVIDER_ENV_MAP)) {
    let key = env[envVar];
    if (provider === "google" && !key) key = env.GEMINI_API_KEY;
    if (key && (auth[provider]?.key !== key || auth[provider]?.type !== "api_key")) {
      auth[provider] = { type: "api_key", key };
      changed = true;
    }
  }
  // Mirror google → GEMINI for Pi if only GOOGLE_API_KEY is stored
  if (env.GOOGLE_API_KEY && env.GEMINI_API_KEY !== env.GOOGLE_API_KEY) {
    env.GEMINI_API_KEY = env.GOOGLE_API_KEY;
    process.env.GEMINI_API_KEY = env.GOOGLE_API_KEY;
    saveJSON(ENV_FILE, env);
  }
  if (changed) {
    saveJSON(AUTH_FILE, auth);
    log("synced API keys from env.json -> auth.json");
  }
}

(function injectEnv() {
  const env = loadJSON(ENV_FILE);
  for (const [k, v] of Object.entries(env)) {
    process.env[k] = v;
  }
  if (Object.keys(env).length) log("injected stored env vars:", Object.keys(env).join(", "));
  syncEnvApiKeysToAuth();
  ensurePiModelsJson();
})();

// Set up the user's work directory from env var
const SANDBOX_USER_ID = process.env.SANDBOX_USER_ID || "";
if (SANDBOX_USER_ID) {
  mkdirSync(WORK, { recursive: true });
  for (const d of TOOL_DIRS) mkdirSync(join(d, ".broken"), { recursive: true });
  log(`serving user: ${SANDBOX_USER_ID}`);
}

// Persist MCP registry for future Pi MCP wiring (v1: registry kept, not loaded into Pi).
(function generateConfig() {
  mkdirSync("/data/pi", { recursive: true });
  const customMcp = loadJSON(MCP_FILE);
  writeFileSync(
    "/data/pi/mcp-registry.json",
    JSON.stringify({ note: "Punch Pi v1 — MCP deferred", mcp: customMcp }, null, 2),
  );
  log(`pi sandbox ready for user: ${SANDBOX_USER_ID || "(none)"} (MCP registry saved, not active)`);
})();

start();

// Reconnect when a key was previously stored in the persistent /data volume.
(function autoTailscale() {
  let key;
  try {
    key = JSON.parse(readFileSync("/data/tailscale_key.json", "utf8")).authkey;
  } catch {
    return;
  }
  if (!key) return;

  setTimeout(() => {
    execFile("tailscale", ["up", `--authkey=${key}`, "--accept-routes", "--accept-dns=false"], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) log(`tailscale auto-connect failed: ${(stderr || err.message).trim()}`);
      else log("tailscale connected (stored key)");
    });
  }, 2000);
})();

// --- HTTP API Server ---
const API_PORT = 4097;

function validDoctorToken(req) {
  const expected = process.env.PUNCH_DOCTOR_TOKEN || "";
  const received = String(req.headers["x-punch-doctor-token"] || "");
  if (!expected || received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

const apiServer = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // --- Inter-sandbox message relay (no auth — internal network only) ---
  if (req.method === "POST" && url.pathname === "/pigeon") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const { from: bodyFrom, text, agent, hop } = JSON.parse(body);
        if (!text) { res.writeHead(400); res.end(JSON.stringify({ error: "Missing text" })); return; }
        const peer = await resolvePeerSandbox(req);
        let from;
        if (!peer) {
          res.writeHead(403); res.end(JSON.stringify({ error: "Could not verify pigeon sender" })); return;
        }
        if (peer.peer === "sandbox") {
          from = peer.name;
        } else if (peer.peer === "bot") {
          if (!bodyFrom) { res.writeHead(400); res.end(JSON.stringify({ error: "Missing from" })); return; }
          from = bodyFrom;
        } else {
          res.writeHead(403); res.end(JSON.stringify({ error: "Could not verify pigeon sender" })); return;
        }
        const agentFlag = !!agent;
        const hopNum = agentFlag ? (Number(hop) || 0) : undefined;
        const entry = { from, text, ts: Date.now() };
        if (agentFlag) {
          entry.agent = true;
          entry.hop = hopNum;
        }
        const msgs = loadJSON("/data/pigeon.json");
        msgs.messages = [...(msgs.messages || []).slice(-49), entry];
        saveJSON("/data/pigeon.json", msgs);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true, delivery: agentFlag ? "agent task queued" : "notification delivered", from, recipient: process.env.SANDBOX_NAME || null }));
        // Fire-and-forget notification to the bot
        const botAuth = "Basic " + Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD || ""}`).toString("base64");
        const notifyBody = { recipientId: process.env.SANDBOX_USER_ID || "", from, text };
        if (agentFlag) {
          notifyBody.agent = true;
          notifyBody.hop = hopNum;
        }
        fetch("http://bot:4098/pigeon/notify", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: botAuth },
          body: JSON.stringify(notifyBody),
        }).catch(() => {});
      } catch { res.writeHead(400); res.end(JSON.stringify({ error: "Invalid JSON" })); }
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/pigeon") {
    const msgs = loadJSON("/data/pigeon.json");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ messages: msgs.messages || [] }));
    return;
  }

  const authHeader = req.headers.authorization || "";
  const expectedAuth = "Basic " + Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME || "opencode"}:${process.env.OPENCODE_SERVER_PASSWORD || ""}`).toString("base64");
  if (authHeader !== expectedAuth) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Sandbox API"' });
    res.end("Unauthorized");
    return;
  }

  if (req.method === "GET" && url.pathname === "/doctor") {
    if (!validDoctorToken(req)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid sandbox doctor credential." }));
      return;
    }
    resolvePeerSandbox(req).then((peer) => {
      if (peer?.peer !== "bot") {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Doctor diagnostics are available only to the Punch bot." }));
        return null;
      }
      return runSandboxDoctor({
      deep: url.searchParams.get("deep") === "true",
      gatewayProcess: child,
      gatewayStartedAt: startedAt,
      probeUrl: PROBE_URL,
      probeAuth: PROBE_AUTH,
      currentModel: CURRENT_MODEL,
      authFile: AUTH_FILE,
      providerEnvMap: PROVIDER_ENV_MAP,
        toolDirs: TOOL_DIRS,
      });
    }).then((diagnostics) => {
      if (!diagnostics) return;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(diagnostics));
    }).catch((error) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/doctor/fix") {
    if (!validDoctorToken(req)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid sandbox doctor credential." }));
      return;
    }
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 4096) req.destroy();
    });
    req.on("end", async () => {
      try {
        const peer = await resolvePeerSandbox(req);
        if (peer?.peer !== "bot") {
          res.writeHead(403, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Doctor repairs are available only to the Punch bot." }));
          return;
        }
        const { action } = JSON.parse(body || "{}");
        if (action === "restart-gateway") {
          forceRestart();
          res.writeHead(202, { "content-type": "application/json" });
          res.end(JSON.stringify({ success: true, message: "Pi gateway restart requested." }));
          return;
        }
        const repaired = repairSandboxDoctor(action);
        if (repaired.success && action === "reset-browser") forceRestart();
        res.writeHead(repaired.success ? 200 : 400, { "content-type": "application/json" });
        res.end(JSON.stringify(repaired));
      } catch (error) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: error.message || "Invalid JSON" }));
      }
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/pigeon/send") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const { to, text, agent, hop } = JSON.parse(body);
        if (!to || !text) { res.writeHead(400); res.end(JSON.stringify({ error: "Missing to or text" })); return; }
        const from = process.env.SANDBOX_NAME;
        if (!from) { res.writeHead(500); res.end(JSON.stringify({ error: "SANDBOX_NAME not configured" })); return; }
        const payload = { text };
        if (agent) {
          payload.agent = true;
          payload.hop = Number(hop) || 0;
        }
        const target = `http://sandbox-${to}:4097/pigeon`;
        const fwd = await fetch(target, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const fwdText = await fwd.text().catch(() => "");
        let delivery = { success: fwd.ok, delivery: fwd.ok ? "notification delivered" : "delivery failed", recipient: to };
        try { delivery = { ...delivery, ...JSON.parse(fwdText) }; } catch {}
        res.writeHead(fwd.status, { "content-type": "application/json" });
        res.end(JSON.stringify(delivery));
      } catch (err) {
        res.writeHead(500); res.end(JSON.stringify({ error: err.message || "Forward failed" }));
      }
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/tasks") {
    exec('ps -eo pid,ppid,stat,start,time,cmd --no-headers', (err, stdout) => {
      if (err) { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); return; }
      const tasks = [];
      for (const line of stdout.trim().split("\n")) {
        if (!line.trim()) continue;
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/);
        if (!m) continue;
        const [_, pid, ppid, stat, start, time, cmd] = m;
        const c = cmd.toLowerCase();
        if (c.includes("serve-supervisor") || c.includes("pi-gateway") ||
            c.includes("opencode serve") ||
            c.includes("xvfb") || c.includes("fluxbox") || c.includes("x11vnc") ||
            c.includes("websockify") || c.includes("dbus-daemon") ||
            c.includes("ps -eo") || c.includes("/lib/systemd") ||
            c.includes("chrome") || c.includes("puppeteer") ||
            stat.toUpperCase() === "Z" || c.includes("<defunct>")) continue;
        tasks.push({ pid: parseInt(pid), ppid: parseInt(ppid), stat, start, time, cmd });
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ tasks }));
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/tasks/kill") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const pid = parseInt(JSON.parse(body).pid);
        exec(`kill -9 ${pid}`, () => {});
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
      } catch { res.writeHead(400); res.end(JSON.stringify({ error: "Invalid JSON" })); }
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/tasks/run") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const { command } = parseTaskBody(body, req.headers["content-type"]);
        const logFile = `/work/task_${Date.now()}.log`;
        exec(`nohup ${command} > ${logFile} 2>&1 & echo $!`, (err, stdout) => {
          const pid = parseInt(stdout.trim());
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, pid, logFile: logFile.replace(/^\/work\//, "") }));
        });
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message || "Invalid JSON" }));
      }
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/tasks/exec") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const parsed = parseTaskBody(body, req.headers["content-type"]);
        const command = parsed.command;
        const timeout = parsed.timeout ?? 30000;
        exec(command, { timeout }, (err, stdout, stderr) => {
          const exitCode = err ? (err.code || err.status || 1) : 0;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ exitCode, stdout: stdout || "", stderr: stderr || "", killed: err ? (err.killed || !!err.signal) : false, signal: err ? (err.signal || null) : null }));
        });
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message || "Invalid JSON" }));
      }
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/env") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const { key, value } = JSON.parse(body);
        if (!key) { res.writeHead(400); res.end(JSON.stringify({ error: "Missing key" })); return; }
        const env = loadJSON(ENV_FILE);
        if (value) { env[key] = value; process.env[key] = value; }
        else { delete env[key]; delete process.env[key]; }
        if (key === "GOOGLE_API_KEY") {
          mirrorGoogleGemini(env, value || null);
        } else if (key === "GEMINI_API_KEY" && value) {
          // Pi reads GEMINI; also keep GOOGLE_API_KEY for PROVIDER_ENV_MAP
          if (!env.GOOGLE_API_KEY) {
            env.GOOGLE_API_KEY = value;
            process.env.GOOGLE_API_KEY = value;
          }
        } else if (key === "GEMINI_API_KEY" && !value) {
          mirrorGoogleGemini(env, null);
        }
        saveJSON(ENV_FILE, env);
        for (const [provider, envVar] of Object.entries(PROVIDER_ENV_MAP)) {
          if (
            key === envVar ||
            (provider === "google" && (key === "GEMINI_API_KEY" || key === "GOOGLE_API_KEY"))
          ) {
            syncAuthProvider(provider, env[envVar] || env.GEMINI_API_KEY || null);
          }
        }
        forceRestart();
        res.writeHead(200); res.end(JSON.stringify({ success: true }));
      } catch { res.writeHead(400); res.end(JSON.stringify({ error: "Invalid JSON" })); }
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/env") {
    res.writeHead(200); res.end(JSON.stringify({ env: loadJSON(ENV_FILE) }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/secrets") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const { key, value } = JSON.parse(body);
        if (!key) { res.writeHead(400); res.end(JSON.stringify({ error: "Missing key" })); return; }
        const secrets = loadJSON(SECRETS_FILE);
        if (value) { secrets[key] = value; } else { delete secrets[key]; }
        saveJSON(SECRETS_FILE, secrets);
        res.writeHead(200); res.end(JSON.stringify({ success: true }));
      } catch { res.writeHead(400); res.end(JSON.stringify({ error: "Invalid JSON" })); }
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/secrets") {
    res.writeHead(200); res.end(JSON.stringify({ secrets: loadJSON(SECRETS_FILE) }));
    return;
  }

  // --- Model management ---
  if (req.method === "GET" && url.pathname === "/model") {
    res.writeHead(200); res.end(JSON.stringify({ model: CURRENT_MODEL }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/model") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const { model } = JSON.parse(body);
        if (!model) { res.writeHead(400); res.end(JSON.stringify({ error: "Missing model" })); return; }
        const normalized = normalizeModel(model);
        CURRENT_MODEL = normalized;
        process.env.OPENCODE_DEFAULT_MODEL = normalized;
        process.env.OPENCODE_MODEL = normalized;
        saveModel(normalized);
        forceRestart();
        res.writeHead(200); res.end(JSON.stringify({ success: true, model: normalized }));
        log(`model changed to: ${normalized}` + (normalized !== model ? ` (from ${model})` : ""));
      } catch { res.writeHead(400); res.end(JSON.stringify({ error: "Invalid JSON" })); }
    });
    return;
  }

  // --- API key management ---
  if (req.method === "GET" && url.pathname === "/apikeys") {
    const env = loadJSON(ENV_FILE);
    const configured = [];
    for (const [provider, envVar] of Object.entries(PROVIDER_ENV_MAP)) {
      if (env[envVar]) configured.push(provider);
    }
    // also include any _API_KEY env vars for custom providers
    for (const k of Object.keys(env)) {
      if (k.endsWith("_API_KEY") && !configured.includes(k.replace("_API_KEY", "").toLowerCase())) {
        configured.push(k.replace("_API_KEY", "").toLowerCase());
      }
    }
    res.writeHead(200); res.end(JSON.stringify({ providers: configured }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/apikey") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const { provider, key } = JSON.parse(body);
        if (!provider) { res.writeHead(400); res.end(JSON.stringify({ error: "Missing provider" })); return; }
        const id = provider.toLowerCase();
        const envVar = PROVIDER_ENV_MAP[id] || (provider.toUpperCase() + "_API_KEY");
        const env = loadJSON(ENV_FILE);
        if (key) {
          env[envVar] = key;
        } else {
          delete env[envVar];
        }
        if (id === "google") mirrorGoogleGemini(env, key || null);
        saveJSON(ENV_FILE, env);
        if (key) { process.env[envVar] = key; } else { delete process.env[envVar]; }
        syncAuthProvider(provider, key);
        forceRestart();
        res.writeHead(200); res.end(JSON.stringify({ success: true, provider }));
        log(`apikey ${key ? "set" : "removed"} for: ${provider}`);
      } catch { res.writeHead(400); res.end(JSON.stringify({ error: "Invalid JSON" })); }
    });
    return;
  }

  // --- Instruction skills: Markdown only, no gateway reload required. ---
  if (req.method === "GET" && url.pathname === "/skills") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ skills: listSkills() }));
    return;
  }

  const skillMatch = url.pathname.match(/^\/skills\/([a-z0-9][a-z0-9_-]{0,63})$/i);
  if (req.method === "GET" && skillMatch) {
    const skill = inspectSkill(skillMatch[1]);
    if (!skill) { res.writeHead(404); res.end(JSON.stringify({ error: "Skill not found" })); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ skill }));
    return;
  }

  if (req.method === "POST" && skillMatch) {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 4096) req.destroy(); });
    req.on("end", () => {
      try {
        const { enabled } = JSON.parse(body || "{}");
        if (typeof enabled !== "boolean") throw new Error("enabled must be boolean");
        const skill = setSkillEnabled(skillMatch[1], enabled);
        if (!skill) { res.writeHead(404); res.end(JSON.stringify({ error: "Skill not found" })); return; }
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ skill }));
      } catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: error.message })); }
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/skills/proposals") {
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ proposals: listProposals() })); return;
  }

  if (req.method === "POST" && url.pathname === "/skills/proposals") {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 45_000) req.destroy(); });
    req.on("end", () => {
      try { const proposal = proposeSkill(JSON.parse(body || "{}")); res.writeHead(201, { "content-type": "application/json" }); res.end(JSON.stringify({ proposal })); }
      catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: error.message })); }
    });
    return;
  }

  const proposalMatch = url.pathname.match(/^\/skills\/proposals\/([a-z0-9-]{6,80})$/i);
  if (req.method === "POST" && proposalMatch) {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 1024) req.destroy(); });
    req.on("end", () => {
      try { const result = reviewProposal(proposalMatch[1], Boolean(JSON.parse(body || "{}").approve)); if (!result) { res.writeHead(404); res.end(JSON.stringify({ error: "Proposal not found" })); return; } res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ result })); }
      catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: error.message })); }
    });
    return;
  }

  // --- Isolated workers. Each process has its own Pi RPC session and timeout. ---
  if (req.method === "GET" && url.pathname === "/workers/settings") {
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ settings: getWorkerSettings() })); return;
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
    return;
  }

  if (req.method === "GET" && url.pathname === "/workers") {
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ workers: listWorkers() })); return;
  }

  if (req.method === "POST" && url.pathname === "/workers") {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 25_000) req.destroy(); });
    req.on("end", () => {
      try {
        const worker = startWorker({ ...JSON.parse(body || "{}"), notifyProgress: async (progress) => {
          const authorization = "Basic " + Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD || ""}`).toString("base64");
          await fetch("http://bot:4098/workers/progress", { method: "POST", headers: { "content-type": "application/json", authorization }, body: JSON.stringify({ userId: process.env.SANDBOX_USER_ID || "", worker: progress }) });
        }, notify: async (completed) => {
          const authorization = "Basic " + Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD || ""}`).toString("base64");
          await fetch("http://bot:4098/workers/complete", { method: "POST", headers: { "content-type": "application/json", authorization }, body: JSON.stringify({ userId: process.env.SANDBOX_USER_ID || "", worker: completed }) });
        } });
        res.writeHead(202, { "content-type": "application/json" }); res.end(JSON.stringify({ worker }));
      } catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: error.message })); }
    });
    return;
  }

  const workerMatch = url.pathname.match(/^\/workers\/([a-f0-9-]{8,64})(?:\/(stop|logs))?$/i);
  if (workerMatch && req.method === "POST" && workerMatch[2] === "stop") {
    const worker = stopWorker(workerMatch[1]);
    if (!worker) { res.writeHead(404); res.end(JSON.stringify({ error: "Worker not found" })); return; }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ worker })); return;
  }
  if (workerMatch && req.method === "GET" && workerMatch[2] === "logs") {
    const data = workerLogs(workerMatch[1]);
    if (!data) { res.writeHead(404); res.end(JSON.stringify({ error: "Worker not found" })); return; }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(data)); return;
  }

  // --- Tools management ---
  if (req.method === "GET" && url.pathname === "/tools") {
    const tools = [];
    for (const dir of TOOL_DIRS) {
      let entries;
      try { entries = readdirSync(dir); } catch { continue; }
      for (const name of entries) {
        if (name === ".broken") continue;
        if (!/\.(ts|js|mjs|cjs)$/.test(name)) continue;
        const full = join(dir, name);
        try {
          const s = statSync(full);
          tools.push({ name, dir, size: s.size, mtime: s.mtimeMs });
        } catch {}
      }
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ tools }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/tools/remove") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const { name } = JSON.parse(body);
        if (!name) { res.writeHead(400); res.end(JSON.stringify({ error: "Missing name" })); return; }
        if (name.includes("/") || name.includes("..")) {
          res.writeHead(400); res.end(JSON.stringify({ error: "Invalid name" }));
          return;
        }
        let removed = false;
        for (const dir of TOOL_DIRS) {
          const full = join(dir, name);
          try {
            renameSync(full, join(dir, ".broken", name));
            removed = true;
          } catch {}
        }
        if (!removed) { res.writeHead(404); res.end(JSON.stringify({ error: "Tool not found" })); return; }
        // Trigger tool reload
        forceRestart();
        res.writeHead(200); res.end(JSON.stringify({ success: true }));
      } catch { res.writeHead(400); res.end(JSON.stringify({ error: "Invalid JSON" })); }
    });
    return;
  }

  // --- Extension management (soft enable/disable) ---
  function loadDisabledExts() {
    try { return JSON.parse(readFileSync(EXT_DISABLED_FILE, "utf8")); } catch { return {}; }
  }
  function saveDisabledExts(obj) {
    writeFileSync(EXT_DISABLED_FILE, JSON.stringify(obj, null, 2));
  }
  function listAllExtensions() {
    const results = [];
    const seen = new Set();
    const disabled = loadDisabledExts();
    for (const dir of TOOL_DIRS) {
      let entries;
      try { entries = readdirSync(dir); } catch { continue; }
      for (const name of entries) {
        if (!/\.(ts|js|mjs|cjs)$/.test(name)) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        const full = join(dir, name);
        const brokenDir = join(dir, ".broken");
        const isQuarantined = existsSync(join(brokenDir, name));
        const isDisabled = !!disabled[name];
        let size = 0;
        let mtime = 0;
        try { const s = statSync(full); size = s.size; mtime = s.mtimeMs; } catch {}
        results.push({ name, dir, size, mtime, disabled: isDisabled, quarantined: isQuarantined });
      }
    }
    // Also list quarantined extensions not in any active dir
    for (const dir of TOOL_DIRS) {
      const brokenDir = join(dir, ".broken");
      let entries;
      try { entries = readdirSync(brokenDir); } catch { continue; }
      for (const name of entries) {
        if (!/\.(ts|js|mjs|cjs)$/.test(name)) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        let size = 0;
        let mtime = 0;
        try { const s = statSync(join(brokenDir, name)); size = s.size; mtime = s.mtimeMs; } catch {}
        results.push({ name, dir, size, mtime, disabled: !!disabled[name], quarantined: true });
      }
    }
    return results;
  }

  if (req.method === "GET" && url.pathname === "/extensions") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ extensions: listAllExtensions() }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/extensions/disable") {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on("end", () => {
      try {
        const { name } = JSON.parse(body || "{}");
        if (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) {
          res.writeHead(400); res.end(JSON.stringify({ error: "Invalid extension name" }));
          return;
        }
        const disabled = loadDisabledExts();
        disabled[name] = true;
        saveDisabledExts(disabled);
        forceRestart();
        res.writeHead(200); res.end(JSON.stringify({ success: true, disabled: Object.keys(disabled) }));
      } catch { res.writeHead(400); res.end(JSON.stringify({ error: "Invalid JSON" })); }
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/extensions/enable") {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on("end", () => {
      try {
        const { name } = JSON.parse(body || "{}");
        if (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) {
          res.writeHead(400); res.end(JSON.stringify({ error: "Invalid extension name" }));
          return;
        }
        const disabled = loadDisabledExts();
        delete disabled[name];
        saveDisabledExts(disabled);
        forceRestart();
        res.writeHead(200); res.end(JSON.stringify({ success: true, disabled: Object.keys(disabled) }));
      } catch { res.writeHead(400); res.end(JSON.stringify({ error: "Invalid JSON" })); }
    });
    return;
  }

  // --- Custom MCP server management ---
  // Custom MCP servers are persisted in /data/mcp.json so that generateConfig()
  // (which runs on every supervisor start and would otherwise wipe them) keeps
  // them across container restarts. auth (OAuth) tokens themselves are stored by
  // opencode itself in its mcp-auth.json (on the data volume), so they persist too.
  if (req.method === "GET" && url.pathname === "/mcp") {
    const mcp = loadJSON(MCP_FILE);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ mcp }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/mcp/add") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const { name, type, url: mcpUrl, command, environment, headers, enabled = true } = JSON.parse(body);
        if (!name || !type) {
          res.writeHead(400).end(JSON.stringify({ error: "Missing name or type" }));
          return;
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
          res.writeHead(400).end(JSON.stringify({ error: "Invalid name (letters, digits, _ and - only)" }));
          return;
        }
        const entry = { type, enabled: !!enabled };
        if (type === "remote") {
          if (!mcpUrl) { res.writeHead(400).end(JSON.stringify({ error: "Missing url for remote MCP" })); return; }
          entry.url = mcpUrl;
          if (headers) entry.headers = headers;
        } else if (type === "local") {
          if (!Array.isArray(command) || command.length === 0) {
            res.writeHead(400).end(JSON.stringify({ error: "Missing command array for local MCP" }));
            return;
          }
          entry.command = command;
          if (environment) entry.environment = environment;
        } else {
          res.writeHead(400).end(JSON.stringify({ error: "type must be 'local' or 'remote'" }));
          return;
        }
        const mcp = loadJSON(MCP_FILE);
        mcp[name] = entry;
        saveJSON(MCP_FILE, mcp);
        forceRestart();
        res.writeHead(200).end(JSON.stringify({ success: true, name }));
        log(`mcp added: ${name} (${type})`);
      } catch (e) {
        res.writeHead(400).end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/mcp/remove") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const { name } = JSON.parse(body);
        if (!name) { res.writeHead(400).end(JSON.stringify({ error: "Missing name" })); return; }
        const mcp = loadJSON(MCP_FILE);
        if (!mcp[name]) { res.writeHead(404).end(JSON.stringify({ error: "MCP not found" })); return; }
        delete mcp[name];
        saveJSON(MCP_FILE, mcp);
        forceRestart();
        res.writeHead(200).end(JSON.stringify({ success: true }));
      } catch {
        res.writeHead(400).end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return;
  }

  // MCP OAuth is deferred in Pi v1 (no opencode mcp auth). Registry still CRUD-able.
  if (req.method === "POST" && url.pathname === "/mcp/auth") {
    res.writeHead(501, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: "MCP OAuth not available in Punch Pi v1 — deferred until Pi MCP wiring",
    }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/mcp/logout") {
    res.writeHead(501, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: "MCP logout not available in Punch Pi v1",
    }));
    return;
  }

  // --- Tailscale management ---
  if (req.method === "POST" && url.pathname === "/tailscale/key") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { key } = JSON.parse(body);
        if (typeof key !== "string" || !key.trim()) {
          res.writeHead(400).end(JSON.stringify({ error: "Missing key" }));
          return;
        }
        writeFileSync("/data/tailscale_key.json", JSON.stringify({ authkey: key }));
        execFile("tailscale", ["up", `--authkey=${key}`, "--accept-routes", "--accept-dns=false"], { timeout: 15000 }, (err, stdout, stderr) => {
          if (err) {
            res.writeHead(500).end(JSON.stringify({ error: (stderr || err.message).trim() }));
            return;
          }
          res.writeHead(200).end(JSON.stringify({ success: true, output: stdout.trim() }));
        });
      } catch {
        res.writeHead(400).end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/tailscale/login") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      let force = false;
      try {
        force = Boolean(JSON.parse(body || "{}").force);
      } catch {
        res.writeHead(400).end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }
      const args = ["login", "--accept-routes", "--accept-dns=false"];
      if (force) args.push("--force-reauth");
      const loginProcess = spawn("tailscale", args, { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      let responded = false;
      let timer;
      const urlPattern = /(https:\/\/login\.tailscale\.com\/[^\s]+)/;
      const finish = (status, payload) => {
        if (responded) return;
        responded = true;
        clearTimeout(timer);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const scan = (chunk) => {
        output += chunk.toString();
        const match = output.match(urlPattern);
        if (match) {
          loginProcess.unref();
          finish(200, { success: true, url: match[1] });
        }
      };
      loginProcess.stdout.on("data", scan);
      loginProcess.stderr.on("data", scan);
      loginProcess.on("error", (err) => finish(500, { error: err.message }));
      loginProcess.on("close", () => {
        if (responded) return;
        const match = output.match(urlPattern);
        finish(200, match
          ? { success: true, url: match[1] }
          : { success: true, url: null, output: output.trim() });
      });
      timer = setTimeout(() => {
        if (responded) return;
        loginProcess.unref();
        finish(200, {
          success: true,
          url: null,
          output: output.trim() || "No login URL emitted (may already be authenticated).",
        });
      }, 12000);
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/tailscale/status") {
    execFile("tailscale", ["status", "--json"], { timeout: 10000 }, (err, stdout) => {
      if (err) {
        res.writeHead(500).end(JSON.stringify({ error: err.message }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(stdout);
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/tailscale/down") {
    execFile("tailscale", ["down"], { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) {
        res.writeHead(500).end(JSON.stringify({ error: (stderr || err.message).trim() }));
        return;
      }
      writeFileSync("/data/tailscale_key.json", "{}");
      res.writeHead(200).end(JSON.stringify({ success: true }));
    });
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

apiServer.listen(API_PORT, "0.0.0.0", () => {
  console.log(`[supervisor] API listening on port ${API_PORT}`);
});
