// Sandbox entrypoint. Runs Punch's pi-gateway (HTTP on :4096
// over `pi --mode rpc`) and exposes the supervisor API on :4097.
//
// Self-extension: when the LLM writes a Pi extension into /work/.pi/extensions/,
// this supervisor restarts the gateway so new tools register. Pi loads -e
// extensions at process start.
//
// Sessions persist under /data/pi/sessions. Quarantine: after restart we health-
// probe the gateway; on persistent failure we move the newest extension into
// .broken/ and reload.

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { migrateMcpApiKeyEnvVars } from "/usr/local/lib/mcp-config.mjs";
import {
  API_PORT,
  ENV_FILE,
  MCP_FILE,
  MODEL_DEFAULT,
  TOOL_DIRS,
  WORK,
  loadJSON,
  log,
  saveJSON,
  state,
} from "./supervisor/state.mjs";
import { setupSignalHandlers, setupWatchers, start } from "./supervisor/gateway.mjs";
import {
  ensurePiModelsJson,
  loadModel,
  loadThinkingLevel,
  normalizeModel,
  saveModel,
  syncEnvApiKeysToAuth,
} from "./supervisor/models.mjs";
import { handleMcpRoutes, syncMcpConfig } from "./supervisor/mcp.mjs";
import { handleProviderRoutes } from "./supervisor/providers.mjs";
import { handleSkillsRoutes } from "./supervisor/skills.mjs";
import { handleTailscaleRoutes } from "./supervisor/tailscale.mjs";
import { handleWorkerRoutes } from "./supervisor/workers.mjs";
import { handleBotProxy, handleGeneralRoutes, handlePigeonRelay } from "./supervisor/routes.mjs";

// --- Model selection (saved model wins, else argv[2] or default) ---
const savedModel = loadModel();
state.CURRENT_MODEL = normalizeModel(savedModel || process.argv[2] || MODEL_DEFAULT);
saveModel(state.CURRENT_MODEL);
state.THINKING_LEVEL = loadThinkingLevel();
process.env.PI_DEFAULT_MODEL = state.CURRENT_MODEL;
process.env.PI_MODEL = state.CURRENT_MODEL;

// --- Env / secrets injection ---
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

// Sync Punch MCP registry → Pi adapter config before the gateway starts.
(function generateConfig() {
  mkdirSync("/data/pi", { recursive: true });
  const mcp = loadJSON(MCP_FILE);
  const env = loadJSON(ENV_FILE);
  const migrated = migrateMcpApiKeyEnvVars(mcp, env);
  if (migrated.changed) {
    saveJSON(ENV_FILE, migrated.env);
    for (const [k, v] of Object.entries(migrated.env)) {
      if (k.startsWith("MCP_") && k.endsWith("_API_KEY")) process.env[k] = v;
    }
    for (const k of Object.keys(env)) {
      if (k.startsWith("MCP_") && k.endsWith("_API_KEY") && !migrated.env[k]) delete process.env[k];
    }
    log("migrated legacy MCP API key env vars to collision-free names");
  }
  syncMcpConfig();
  log(`pi sandbox ready for user: ${SANDBOX_USER_ID || "(none)"}`);
})();

start();
setupWatchers();
setupSignalHandlers();

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
const apiServer = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (handlePigeonRelay(req, res, url)) return;

  const authHeader = req.headers.authorization || "";
  const expectedAuth = "Basic " + Buffer.from(`${process.env.PI_SERVER_USERNAME || "pi"}:${process.env.PI_SERVER_PASSWORD || ""}`).toString("base64");
  if (authHeader !== expectedAuth) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Sandbox API"' });
    res.end("Unauthorized");
    return;
  }

  if (await handleBotProxy(req, res, url)) return;
  if (handleGeneralRoutes(req, res, url)) return;
  if (handleProviderRoutes(req, res, url)) return;
  if (handleSkillsRoutes(req, res, url)) return;
  if (handleWorkerRoutes(req, res, url)) return;
  if (handleMcpRoutes(req, res, url)) return;
  if (handleTailscaleRoutes(req, res, url)) return;

  res.writeHead(404);
  res.end("Not Found");
});

apiServer.listen(API_PORT, "0.0.0.0", () => {
  console.log(`[supervisor] API listening on port ${API_PORT}`);
});
