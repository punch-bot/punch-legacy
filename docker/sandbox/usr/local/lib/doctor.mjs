import {
  accessSync,
  constants,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CHECK_TIMEOUT_MS = 10_000;

function elapsed(startedAt) {
  return Math.max(0, Date.now() - startedAt);
}

function result(id, status, title, message, startedAt, fix) {
  const value = { id, status, title, message, durationMs: elapsed(startedAt) };
  if (fix) value.fix = fix;
  return value;
}

function readJson(path, fallback = {}) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function command(file, args, timeout = CHECK_TIMEOUT_MS) {
  try {
    const output = await execFileAsync(file, args, {
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      encoding: "utf8",
    });
    return { ok: true, stdout: output.stdout || "", stderr: output.stderr || "" };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
      error: error.message || String(error),
    };
  }
}

async function piChecks({ gatewayProcess, gatewayStartedAt, probeUrl, probeAuth }) {
  const startedAt = Date.now();
  const checks = [];
  if (gatewayProcess?.pid && gatewayProcess.exitCode === null && gatewayProcess.signalCode === null) {
    const uptimeSeconds = Math.max(0, Math.round((Date.now() - gatewayStartedAt) / 1000));
    checks.push(result("pi-process", "pass", "Pi gateway process", `Running as PID ${gatewayProcess.pid} for ${uptimeSeconds}s.`, startedAt));
  } else {
    checks.push(result("pi-process", "fail", "Pi gateway process", "Gateway child process is not running.", startedAt, "restart-gateway"));
  }

  try {
    const response = await fetch(probeUrl, {
      headers: { authorization: probeAuth },
      signal: AbortSignal.timeout(5_000),
    });
    checks.push(response.ok
      ? result("pi-health", "pass", "Pi gateway health", `Health endpoint returned HTTP ${response.status}.`, startedAt)
      : result("pi-health", "fail", "Pi gateway health", `Health endpoint returned HTTP ${response.status}.`, startedAt, "restart-gateway"));
  } catch (error) {
    checks.push(result("pi-health", "fail", "Pi gateway health", `Health probe failed: ${error.message}`, startedAt, "restart-gateway"));
  }
  return checks;
}

function providerCheck({ currentModel, authFile, providerEnvMap }) {
  const startedAt = Date.now();
  const provider = String(currentModel || "").split("/")[0] || "unknown";
  const auth = readJson(authFile);
  const envName = providerEnvMap[provider];
  const configured = Boolean(auth[provider]?.key || (envName && process.env[envName]) || (provider === "google" && process.env.GEMINI_API_KEY));
  return result(
    "provider",
    configured ? "pass" : "warn",
    "Model provider",
    configured
      ? `${provider} credentials are configured for ${currentModel}.`
      : `${provider} credentials were not found for ${currentModel}.`,
    startedAt,
    configured ? undefined : "Configure the provider with /apikey or /env.",
  );
}

function configurationChecks(authFile) {
  const startedAt = Date.now();
  const checks = [];
  const jsonFiles = [
    "/data/model.json",
    "/data/env.json",
    authFile,
    "/data/gateway-sessions.json",
  ];
  const corrupt = [];
  for (const path of jsonFiles) {
    if (!existsSync(path)) continue;
    try {
      JSON.parse(readFileSync(path, "utf8"));
    } catch {
      corrupt.push(path);
    }
  }
  checks.push(corrupt.length
    ? result("config-json", "fail", "Configuration files", `Invalid JSON: ${corrupt.join(", ")}.`, startedAt, "Restore malformed files from backup or recreate them.")
    : result("config-json", "pass", "Configuration files", "Persistent JSON configuration parses successfully.", startedAt));

  const sessionMap = readJson("/data/gateway-sessions.json");
  const missingSessions = Object.values(sessionMap).filter((path) => typeof path !== "string" || !existsSync(path));
  checks.push(missingSessions.length
    ? result("session-paths", "warn", "Session files", `${missingSessions.length} mapped session file(s) are missing.`, startedAt, "Reset stale sessions or repair gateway-sessions.json.")
    : result("session-paths", "pass", "Session files", "Mapped session files exist.", startedAt));

  const looseFiles = [];
  for (const path of [authFile, "/data/env.json", "/data/secrets.json", "/data/tailscale_key.json"]) {
    if (!existsSync(path)) continue;
    try {
      if ((statSync(path).mode & 0o077) !== 0) looseFiles.push(path);
    } catch {}
  }
  checks.push(looseFiles.length
    ? result("secret-permissions", "warn", "Secret file permissions", `Group/other access is enabled on: ${looseFiles.join(", ")}.`, startedAt, "Tighten secret files to mode 600.")
    : result("secret-permissions", "pass", "Secret file permissions", "Stored credential files are owner-only or absent.", startedAt));
  return checks;
}

function extensionCheck(toolDirs) {
  const startedAt = Date.now();
  let active = 0;
  let broken = 0;
  let disabled = 0;
  const details = [];
  const disabledMap = readJson("/data/pi/extensions-disabled.json");
  const seen = new Set();
  for (const directory of toolDirs) {
    try {
      for (const name of readdirSync(directory)) {
        if (!(name.endsWith(".ts") || name.endsWith(".js"))) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        const isDisabled = !!disabledMap[name];
        if (isDisabled) { disabled++; details.push(`⏸️ ${name} (disabled)`); continue; }
        active++;
        details.push(`✅ ${name}`);
      }
    } catch {}
    try {
      for (const name of readdirSync(`${directory}/.broken`)) {
        if (!(name.endsWith(".ts") || name.endsWith(".js"))) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        broken++;
        details.push(`🔴 ${name} (quarantined)`);
      }
    } catch {}
  }
  const summary = `${active} active; ${disabled} disabled; ${broken} quarantined`;
  return result(
    "extensions",
    broken ? "warn" : "pass",
    "Pi extensions",
    `${summary}\n${details.join("\n")}`,
    startedAt,
    broken ? "Review files under /work/.pi/extensions/.broken." : undefined,
  );
}

async function storageChecks(deep) {
  const startedAt = Date.now();
  const checks = [];
  const paths = ["/work", "/data", "/root"];
  const failures = [];
  for (const path of paths) {
    try {
      accessSync(path, constants.R_OK | constants.W_OK);
    } catch {
      failures.push(path);
    }
  }
  checks.push(failures.length
    ? result("storage-access", "fail", "Sandbox storage", `Not readable and writable: ${failures.join(", ")}.`, startedAt, "repair-storage")
    : result("storage-access", "pass", "Sandbox storage", "/work, /data, and /root are readable and writable.", startedAt));

  try {
    const stats = statfsSync("/data");
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const freeGiB = freeBytes / (1024 ** 3);
    checks.push(result("storage-space", freeGiB < 1 ? "warn" : "pass", "Free storage", `${freeGiB.toFixed(1)} GiB available on /data.`, startedAt, freeGiB < 1 ? "Free disk space before sessions or browser data fail." : undefined));
  } catch (error) {
    checks.push(result("storage-space", "warn", "Free storage", `Could not inspect free space: ${error.message}`, startedAt));
  }

  if (deep) {
    const path = `/work/.punch-doctor-${process.pid}-${Date.now()}`;
    try {
      writeFileSync(path, "doctor");
      if (readFileSync(path, "utf8") !== "doctor") throw new Error("read-back mismatch");
      unlinkSync(path);
      checks.push(result("storage-write-probe", "pass", "Storage write probe", "Temporary write/read/delete probe passed.", startedAt));
    } catch (error) {
      try { unlinkSync(path); } catch {}
      checks.push(result("storage-write-probe", "fail", "Storage write probe", `Probe failed: ${error.message}`, startedAt, "repair-storage"));
    }
  }
  return checks;
}

async function tailscaleChecks() {
  const startedAt = Date.now();
  const checks = [];
  const status = await command("tailscale", ["status", "--json"]);
  if (!status.ok) {
    const message = (status.stderr || status.error || "not authenticated").trim();
    checks.push(result("tailscale-status", "warn", "Tailscale", `Unavailable or logged out: ${message}`, startedAt, "Use /tailscale login or /tailscale key."));
  } else {
    try {
      const data = JSON.parse(status.stdout);
      const backend = data.BackendState || "Unknown";
      const name = data.Self?.DNSName || data.Self?.HostName || "unnamed node";
      checks.push(result("tailscale-status", backend === "Running" ? "pass" : "warn", "Tailscale", `${backend}; ${name}.`, startedAt, backend === "Running" ? undefined : "Use /tailscale login."));
    } catch (error) {
      checks.push(result("tailscale-status", "fail", "Tailscale", `Invalid status JSON: ${error.message}`, startedAt));
    }
  }

  const serve = await command("tailscale", ["serve", "status", "--json"], 5_000);
  if (serve.ok) {
    const exposed = serve.stdout.trim() && serve.stdout.trim() !== "{}" && serve.stdout.trim() !== "null";
    checks.push(result(
      "tailscale-exposure",
      exposed ? "warn" : "pass",
      "Tailscale exposure",
      exposed ? "Tailscale Serve or Funnel configuration is active." : "No Tailscale Serve or Funnel configuration detected.",
      startedAt,
      exposed ? "Review `tailscale serve status` and disable unintended exposure." : undefined,
    ));
  }

  try {
    const resolv = readFileSync("/etc/resolv.conf", "utf8");
    const dockerDns = /^nameserver\s+127\.0\.0\.11\s*$/m.test(resolv);
    checks.push(result(
      "docker-dns",
      dockerDns ? "pass" : "warn",
      "Docker DNS",
      dockerDns ? "Docker resolver 127.0.0.11 is preserved." : "Docker resolver 127.0.0.11 is not present.",
      startedAt,
      dockerDns ? undefined : "Run tailscale with --accept-dns=false and inspect resolv.conf.",
    ));
  } catch (error) {
    checks.push(result("docker-dns", "warn", "Docker DNS", `Could not read resolv.conf: ${error.message}`, startedAt));
  }
  return checks;
}

let deepBrowserProbe = null;
let cachedBrowserProbe = null;
let cachedBrowserProbeAt = 0;

async function runBrowserProbe() {
  if (cachedBrowserProbe && Date.now() - cachedBrowserProbeAt < 30_000) return cachedBrowserProbe;
  if (deepBrowserProbe) return deepBrowserProbe;
  const script = `const p=require('/opt/pi/node_modules/playwright');(async()=>{let b;try{b=await p.chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});const page=await b.newPage();await page.goto('data:text/html,<title>Punch Doctor</title><h1>ok</h1>');const title=await page.title();await page.screenshot({path:'/tmp/punch-doctor-browser.png'});if(title!=='Punch Doctor')process.exitCode=2}catch(e){console.error(e.message);process.exitCode=1}finally{if(b)await b.close()}})()`;
  deepBrowserProbe = command("node", ["-e", script], 20_000)
    .then((probe) => {
      cachedBrowserProbe = probe;
      cachedBrowserProbeAt = Date.now();
      return probe;
    })
    .finally(() => {
      deepBrowserProbe = null;
      try { unlinkSync("/tmp/punch-doctor-browser.png"); } catch {}
    });
  return deepBrowserProbe;
}

async function browserChecks(deep) {
  const startedAt = Date.now();
  let extensionPresent = false;
  try {
    const require = createRequire("/opt/pi/package.json");
    const runtimeDir = dirname(require.resolve("@punch-bot/cli"));
    extensionPresent = existsSync(join(runtimeDir, "extensions/browser/index.js"));
  } catch {}
  const checks = [extensionPresent
    ? result("browser-extension", "pass", "Browser extension", "Built-in browser extension is installed.", startedAt)
    : result("browser-extension", "fail", "Browser extension", "Browser extension is missing.", startedAt, "restart-gateway")];
  if (!deep) return checks;

  const probe = await runBrowserProbe();
  checks.push(probe.ok
    ? result("browser-probe", "pass", "Browser deep probe", "Chromium launch, navigation, title read, and screenshot passed.", startedAt)
    : result("browser-probe", "fail", "Browser deep probe", `Probe failed: ${(probe.stderr || probe.error).trim()}`, startedAt, "reset-browser"));
  return checks;
}

export async function runSandboxDoctor(options) {
  const startedAt = Date.now();
  const groups = await Promise.all([
    piChecks(options),
    Promise.resolve([providerCheck(options)]),
    Promise.resolve(configurationChecks(options.authFile)),
    Promise.resolve([extensionCheck(options.toolDirs)]),
    storageChecks(Boolean(options.deep)),
    tailscaleChecks(),
    browserChecks(Boolean(options.deep)),
  ]);
  return { checks: groups.flat(), durationMs: elapsed(startedAt) };
}

export function repairSandboxDoctor(action) {
  if (action === "repair-storage") {
    try {
      for (const path of ["/work", "/data", "/root", "/work/.pi/extensions", "/work/screenshots", "/data/pi/sessions", "/data/pi/agent"]) {
        mkdirSync(path, { recursive: true });
      }
      for (const root of ["/work", "/data", "/root"]) {
        const probe = `${root}/.punch-doctor-repair-${process.pid}`;
        writeFileSync(probe, "ok");
        if (readFileSync(probe, "utf8") !== "ok") throw new Error(`${root} read-back mismatch`);
        unlinkSync(probe);
      }
      return { success: true, message: "Required storage directories recreated and write access verified." };
    } catch (error) {
      return { success: false, message: `Storage repair could not restore write access: ${error.message}` };
    }
  }
  if (action === "repair-permissions") {
    let changed = 0;
    for (const path of ["/data/pi/agent/auth.json", "/data/env.json", "/data/secrets.json", "/data/tailscale_key.json"]) {
      if (!existsSync(path)) continue;
      chmodSync(path, 0o600);
      changed += 1;
    }
    return { success: true, message: `Tightened permissions on ${changed} credential file(s).` };
  }
  if (action === "reset-browser") {
    cachedBrowserProbe = null;
    cachedBrowserProbeAt = 0;
    rmSync("/root/.chrome-profile", { recursive: true, force: true });
    mkdirSync("/root/.chrome-profile", { recursive: true });
    return { success: true, message: "Browser profile reset. Saved browser logins were removed." };
  }
  return { success: false, message: "Unsupported doctor repair action." };
}
