import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const ROOT = "/data/workers";
const RECORDS_FILE = join(ROOT, "records.json");
const SETTINGS_FILE = join(ROOT, "settings.json");
const DEFAULT_WORKER_CAP = 3;
const MIN_WORKER_CAP = 1;
const MAX_WORKER_CAP = 10;
const MAX_TIMEOUT_MS = 30 * 60_000;
const MAX_OUTPUT_CHARS = 20_000;
const active = new Map();

function readJson(file, fallback) { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; } }
function save(records) { mkdirSync(ROOT, { recursive: true }); const temporary = `${RECORDS_FILE}.${process.pid}.tmp`; writeFileSync(temporary, JSON.stringify(records.slice(-100), null, 2) + "\n", { mode: 0o600 }); renameSync(temporary, RECORDS_FILE); }
function clampWorkerCap(value) {
  const cap = Math.floor(Number(value));
  if (!Number.isFinite(cap)) return DEFAULT_WORKER_CAP;
  return Math.max(MIN_WORKER_CAP, Math.min(MAX_WORKER_CAP, cap));
}
function readWorkerSettings() { return readJson(SETTINGS_FILE, { cap: DEFAULT_WORKER_CAP }); }
function saveWorkerSettings(settings) {
  mkdirSync(ROOT, { recursive: true });
  const temporary = `${SETTINGS_FILE}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporary, SETTINGS_FILE);
}
export function getWorkerCap() { return clampWorkerCap(readWorkerSettings().cap); }
export function getWorkerSettings() {
  const cap = getWorkerCap();
  const active = activeWorkers();
  return { cap, active, available: Math.max(0, cap - active) };
}
export function setWorkerCap(cap) {
  const next = { cap: clampWorkerCap(cap) };
  saveWorkerSettings(next);
  return getWorkerSettings();
}
function activeWorkers() { return active.size; }
function records() { return readJson(RECORDS_FILE, []); }
function update(id, patch) { const all = records(); const index = all.findIndex((entry) => entry.id === id); if (index >= 0) { all[index] = { ...all[index], ...patch }; save(all); return all[index]; } return null; }
function modelParts(model) { const slash = model.indexOf("/"); return slash > 0 ? [model.slice(0, slash), model.slice(slash + 1)] : [model, model]; }
function safeProgress(phase, detail) {
  const allowed = new Set(["queued", "starting", "working", "tool", "finalizing", "timed_out", "failed"]);
  return { phase: allowed.has(phase) ? phase : "working", detail: String(detail || "Working").replace(/[\r\n`]/g, " ").slice(0, 180) };
}

export function listWorkers() { return records().map((record) => ({ ...record, active: active.has(record.id) })).reverse(); }
export function workerLogs(id) { if (!/^[a-f0-9-]{8,64}$/i.test(id)) return null; const record = records().find((entry) => entry.id === id); if (!record) return null; let log = ""; try { log = readFileSync(record.logFile, "utf8").slice(-MAX_OUTPUT_CHARS); } catch {} return { record, log }; }

export function stopWorker(id) {
  const process = active.get(id);
  if (!process) return update(id, { status: "stopped", phase: "stopped", detail: "Stopped", finishedAt: Date.now() });
  process.kill("SIGTERM");
  setTimeout(() => { try { process.kill("SIGKILL"); } catch {} }, 5_000).unref();
  return update(id, { status: "stopping", phase: "stopping", detail: "Stopping worker", lastUpdateAt: Date.now() });
}

export function startWorker({ prompt, kind = "research", model, timeoutMs = 600_000, maxTokens = 2_000, channelId = null, messageId = null, source = null, notify, notifyProgress }) {
  const cap = getWorkerCap();
  if (active.size >= cap) throw new Error(`Worker limit reached (${cap})`);
  if (!["research", "coding", "browser"].includes(kind)) throw new Error("kind must be research, coding, or browser");
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 20_000) throw new Error("prompt must be 1-20000 characters");
  const safeModel = String(model || process.env.PI_MODEL || process.env.OPENCODE_MODEL || "opencode/big-pickle");
  if (!/^[A-Za-z0-9._/-]+$/.test(safeModel)) throw new Error("Invalid model");
  const id = randomUUID();
  const workdir = join(ROOT, id);
  const logFile = join(workdir, "worker.log");
  const sessionDir = join(workdir, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  // Persist the Discord channel that spawned this worker so multitask results
  // reply in-channel instead of only DMing (and so we never ReferenceError).
  const record = { id, kind, model: safeModel, status: "queued", phase: "queued", detail: "Queued", lastTool: null, lastUpdateAt: Date.now(), createdAt: Date.now(), startedAt: null, finishedAt: null, timeoutMs: Math.max(1_000, Math.min(MAX_TIMEOUT_MS, Number(timeoutMs) || 600_000)), maxTokens: Math.max(128, Math.min(16_000, Number(maxTokens) || 2_000)), logFile, channelId: channelId ? String(channelId) : null, messageId: messageId ? String(messageId) : null, source: source ? String(source) : null, error: null, result: null };
  const all = records(); all.push(record); save(all);
  const [provider, modelId] = modelParts(safeModel);
  const toolList = kind === "research" ? "read,grep,find,ls" : kind === "browser" ? "puppeteer_navigate,puppeteer_screenshot,puppeteer_click,puppeteer_fill,puppeteer_select,puppeteer_hover" : "bash,read,write,edit";
  const policy = kind === "research"
    ? "Read-only investigation in /work. No writes, bash, or browser."
    : kind === "browser"
      ? "Browser research only. No file writes or bash."
      : "Focused changes in /work only. Report what you changed.";
  const bootstrap = `Isolated Punch worker (${kind}). ${policy}\nReturn concise findings or results. No subagents, extensions, secrets, outbound messages, or extra tools.`;
  const args = ["/usr/local/bin/pi-worker-runner.mjs", provider, modelId, sessionDir, toolList, `${bootstrap}\n\nTask:\n${prompt}`];
  const child = spawn("node", args, { cwd: "/work", env: { ...process.env, PUNCH_WORKER_TIMEOUT_MS: String(record.timeoutMs) }, stdio: ["ignore", "pipe", "pipe"] });
  active.set(id, child);
  let lastProgressAt = 0;
  const progress = (phase, detail, force = false) => {
    const safe = safeProgress(phase, detail);
    const now = Date.now();
    if (!force && now - lastProgressAt < 3_000 && safe.phase !== "tool") return;
    lastProgressAt = now;
    const next = update(id, { phase: safe.phase, detail: safe.detail, lastTool: safe.phase === "tool" ? safe.detail : undefined, lastUpdateAt: now, status: safe.phase === "queued" ? "queued" : "running", startedAt: records().find((entry) => entry.id === id)?.startedAt || now });
    Promise.resolve(notifyProgress?.(next)).catch(() => {});
  };
  progress("starting", "Starting isolated Pi process", true);
  const timer = setTimeout(() => { const timedOut = update(id, { status: "timed_out", phase: "timed_out", detail: "Worker time limit reached", error: `Exceeded ${record.timeoutMs}ms`, lastUpdateAt: Date.now() }); Promise.resolve(notifyProgress?.(timedOut)).catch(() => {}); child.kill("SIGTERM"); }, record.timeoutMs);
  let output = "";
  let lineBuffer = "";
  const consume = (chunk, isError = false) => {
    const value = chunk.toString("utf8");
    output = (output + value).slice(-MAX_OUTPUT_CHARS);
    writeFileSync(logFile, output, { mode: 0o600 });
    if (isError) return;
    lineBuffer += value;
    let end;
    while ((end = lineBuffer.indexOf("\n")) >= 0) {
      const line = lineBuffer.slice(0, end); lineBuffer = lineBuffer.slice(end + 1);
      if (!line.startsWith("PUNCH_WORKER_EVENT ")) continue;
      try { const event = JSON.parse(line.slice("PUNCH_WORKER_EVENT ".length)); progress(event.phase, event.detail, event.phase === "failed" || event.phase === "timed_out"); } catch {}
    }
  };
  child.stdout.on("data", (chunk) => consume(chunk));
  child.stderr.on("data", (chunk) => consume(chunk, true));
  child.once("error", (error) => { clearTimeout(timer); active.delete(id); const failed = update(id, { status: "failed", phase: "failed", detail: "Could not start worker", error: error.message, finishedAt: Date.now(), lastUpdateAt: Date.now() }); Promise.resolve(notify?.(failed)).catch(() => {}); });
  child.once("exit", (code, signal) => {
    clearTimeout(timer); active.delete(id);
    const latest = records().find((entry) => entry.id === id);
    const status = latest?.status === "timed_out" ? "timed_out" : code === 0 ? "succeeded" : signal === "SIGTERM" ? "stopped" : "failed";
    const result = output.slice(-8_000);
    const completed = update(id, { status, phase: status, detail: status === "succeeded" ? "Completed" : latest?.detail || "Worker stopped", finishedAt: Date.now(), result, error: status === "failed" ? `pi exited code=${code} signal=${signal}` : latest?.error || null, lastUpdateAt: Date.now() });
    Promise.resolve(notify?.(completed)).catch(() => {});
  });
  return record;
}
