import { exec, execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePeerSandbox } from "/usr/local/lib/pigeon-peer.js";
import { repairSandboxDoctor, runSandboxDoctor } from "/usr/local/lib/doctor.mjs";
import { redactMcpKeysFromEnvView } from "/usr/local/lib/mcp-config.mjs";
import { PROVIDER_ENV_MAP, mirrorGoogleGemini, syncAuthProvider } from "./models.mjs";
import { forceRestart } from "./gateway.mjs";
import {
  AUTH_FILE,
  BOT_TOKEN,
  DOCTOR_TOKEN,
  ENV_FILE,
  EXT_DISABLED_FILE,
  PROBE_URL,
  SECRETS_FILE,
  TOOL_DIRS,
  log,
  loadJSON,
  probeAuth,
  safeEqual,
  saveJSON,
  state,
} from "./state.mjs";

export function parseTaskBody(raw, contentType = "") {
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

function validDoctorToken(req) {
  return Boolean(DOCTOR_TOKEN) && safeEqual(req.headers["x-punch-doctor-token"], DOCTOR_TOKEN);
}

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

export async function handleBotProxy(req, res, url) {
  if (!url.pathname.startsWith("/bot")) return false;

  const rest = url.pathname.slice("/bot".length);
  const targetPath = rest || "/";
  const target = `http://bot:4098${targetPath}${url.search}`;

  const body = [];
  let size = 0;
  let overflow = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 5 * 1024 * 1024) {
      overflow = true;
      req.destroy();
      break;
    }
    body.push(chunk);
  }

  try {
    if (overflow) {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Request body too large" }));
      return true;
    }
    const bodyBuf = Buffer.concat(body);
    const response = await fetch(target, {
      method: req.method,
      headers: {
        "content-type": req.headers["content-type"] || "application/json",
        authorization: "Bearer " + BOT_TOKEN,
      },
      body: ["GET", "HEAD"].includes(req.method) ? undefined : bodyBuf.length ? bodyBuf : undefined,
    });
    const text = await response.text();
    res.writeHead(response.status, {
      "content-type": response.headers.get("content-type") || "application/json",
    });
    res.end(text);
  } catch (error) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: error.message }));
  }
  return true;
}

export function handleGeneralRoutes(req, res, url) {
  if (req.method === "GET" && url.pathname === "/doctor") {
    if (!validDoctorToken(req)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid sandbox doctor credential." }));
      return true;
    }
    resolvePeerSandbox(req).then((peer) => {
      if (peer?.peer !== "bot") {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Doctor diagnostics are available only to the Punch bot." }));
        return null;
      }
      return runSandboxDoctor({
        deep: url.searchParams.get("deep") === "true",
        gatewayProcess: state.child,
        gatewayStartedAt: state.startedAt,
        probeUrl: PROBE_URL,
        probeAuth: probeAuth(),
        currentModel: state.CURRENT_MODEL,
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
    return true;
  }

  if (req.method === "POST" && url.pathname === "/doctor/fix") {
    if (!validDoctorToken(req)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid sandbox doctor credential." }));
      return true;
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
    return true;
  }

  if (req.method === "POST" && url.pathname === "/pigeon/send") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const { to, text, agent, hop } = JSON.parse(body);
        if (!to || !text) { res.writeHead(400); res.end(JSON.stringify({ error: "Missing to or text" })); return; }
        if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(to)) {
          res.writeHead(400); res.end(JSON.stringify({ error: "Invalid to" })); return;
        }
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
    return true;
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
            c.includes("ps -eo") || c.includes("/lib/systemd") ||
            c.includes("chrome") || c.includes("puppeteer") ||
            stat.toUpperCase() === "Z" || c.includes("<defunct>")) continue;
        tasks.push({ pid: parseInt(pid), ppid: parseInt(ppid), stat, start, time, cmd });
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ tasks }));
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/tasks/kill") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const pid = parseInt(JSON.parse(body).pid);
        if (!Number.isInteger(pid) || pid <= 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid pid" }));
          return;
        }
        exec(`kill -9 ${pid}`, (err) => {
          if (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message || "Kill failed" }));
            return;
          }
          res.writeHead(200);
          res.end(JSON.stringify({ success: true }));
        });
      } catch { res.writeHead(400); res.end(JSON.stringify({ error: "Invalid JSON" })); }
    });
    return true;
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
    return true;
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
    return true;
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
            const fallback = provider === "google" ? env.GEMINI_API_KEY || null : null;
            syncAuthProvider(provider, env[envVar] || fallback);
          }
        }
        forceRestart();
        res.writeHead(200); res.end(JSON.stringify({ success: true }));
      } catch { res.writeHead(400); res.end(JSON.stringify({ error: "Invalid JSON" })); }
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/env") {
    res.writeHead(200); res.end(JSON.stringify({ env: redactMcpKeysFromEnvView(loadJSON(ENV_FILE)) }));
    return true;
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
    return true;
  }

  if (req.method === "GET" && url.pathname === "/secrets") {
    res.writeHead(200); res.end(JSON.stringify({ secrets: loadJSON(SECRETS_FILE) }));
    return true;
  }

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
    return true;
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
        forceRestart();
        res.writeHead(200); res.end(JSON.stringify({ success: true }));
      } catch { res.writeHead(400); res.end(JSON.stringify({ error: "Invalid JSON" })); }
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/extensions") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ extensions: listAllExtensions() }));
    return true;
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
    return true;
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
    return true;
  }

  return false;
}

export function handlePigeonRelay(req, res, url) {
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
        const botAuth = "Bearer " + BOT_TOKEN;
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
    return true;
  }

  if (req.method === "GET" && url.pathname === "/pigeon") {
    const msgs = loadJSON("/data/pigeon.json");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ messages: msgs.messages || [] }));
    return true;
  }

  return false;
}

export { execFile };
