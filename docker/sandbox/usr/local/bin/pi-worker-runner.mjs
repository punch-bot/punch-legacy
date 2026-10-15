#!/usr/bin/env node
import { spawn } from "node:child_process";
import { isTurnSettledEvent } from "/usr/local/lib/pi-turn-completion.mjs";

const [provider, model, sessionDir, tools, prompt] = process.argv.slice(2);
if (!provider || !model || !sessionDir || !prompt) process.exit(2);
const child = spawn("pi", ["--mode", "rpc", "--no-extensions", "--provider", provider, "--model", model, "--session-dir", sessionDir, "--tools", tools], {
  cwd: "/work",
  env: { ...process.env, PI_CODING_AGENT_SESSION_DIR: sessionDir, PI_OFFLINE: process.env.PI_OFFLINE || "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PUNCH_WORKER: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});
let sequence = 0;
let buffer = "";
let output = "";
let ready = false;
let prompted = false;
let timeout;
let lastTool = null;
function event(phase, detail = null) { process.stdout.write(`PUNCH_WORKER_EVENT ${JSON.stringify({ phase, detail, ts: Date.now() })}\n`); }
function send(type, fields = {}) { child.stdin.write(JSON.stringify({ id: `worker-${++sequence}`, type, ...fields }) + "\n"); }
function finish(code = 0) { clearTimeout(timeout); try { child.kill("SIGTERM"); } catch {} setTimeout(() => process.exit(code), 50); }
function text(parts) { return (parts || []).map((part) => typeof part === "string" ? part : part?.text || part?.content || "").join(""); }
function line(raw) {
  let message;
  try { message = JSON.parse(raw); } catch { process.stdout.write(raw + "\n"); return; }
  if (message.type === "ready") { ready = true; event("starting", "Pi ready"); }
  if (message.type === "response" && message.success !== false) ready = true;
  if (ready && !prompted) { prompted = true; event("working", "Sending task to Pi"); send("new_session"); send("prompt", { message: prompt }); }
  if (message.type === "agent_start" || message.type === "turn_start") event("working", "Worker is reasoning and using approved tools");
  if (message.type === "tool_execution_start") {
    lastTool = String(message.toolName || message.name || "tool").slice(0, 80);
    event("tool", lastTool);
  }
  if (message.type === "tool_execution_end" && lastTool) event("working", `Finished ${lastTool}`);
  if (message.type === "message_update" || message.type === "message") {
    const value = text(message.message?.content || message.message?.parts || message.content || message.parts);
    if (value) output = value;
  }
  if (isTurnSettledEvent(message)) {
    event("finalizing", "Preparing result");
    if (output) process.stdout.write(`\n--- worker result ---\n${output}\n`);
    finish(0);
  }
  process.stdout.write(JSON.stringify(message) + "\n");
}
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let position;
  while ((position = buffer.indexOf("\n")) >= 0) { const raw = buffer.slice(0, position); buffer = buffer.slice(position + 1); if (raw.trim()) line(raw); }
});
child.stderr.pipe(process.stderr);
child.once("error", (error) => { event("failed", "Could not start Pi worker"); process.stderr.write(error.message + "\n"); process.exit(1); });
child.once("exit", (code) => { clearTimeout(timeout); process.exitCode = code || 0; });
event("queued", "Starting isolated Pi process");
timeout = setTimeout(() => { event("timed_out", "Worker time limit reached"); process.stderr.write("Worker RPC timeout\n"); try { child.kill("SIGTERM"); } catch {} }, Number(process.env.PUNCH_WORKER_TIMEOUT_MS || 600000));
