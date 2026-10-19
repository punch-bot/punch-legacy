import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  assertPunchEntry,
  isMcpApiKeyConfigured,
  mcpApiKeyEnvVar,
  mcpApiKeyEnvVarsToClear,
  punchRegistryToAdapterConfig,
  sanitizeMcpEntryForDisplay,
  usesMcpApiKeyAuth,
} from "/usr/local/lib/mcp-config.mjs";
import { forceRestart } from "./gateway.mjs";
import { ENV_FILE, MCP_FILE, PI_MCP_FILE, log, loadJSON, saveJSON } from "./state.mjs";

const RESERVED_NAMES = new Set(["__proto__", "constructor", "prototype"]);

export function syncMcpConfig() {
  mkdirSync("/data/pi/agent", { recursive: true });
  const customMcp = loadJSON(MCP_FILE);
  const adapterConfig = punchRegistryToAdapterConfig(customMcp);
  writeFileSync(PI_MCP_FILE, JSON.stringify(adapterConfig, null, 2));
  const names = Object.keys(adapterConfig.mcpServers || {});
  log(`mcp config synced (${names.length} server${names.length === 1 ? "" : "s"}): ${names.join(", ") || "(none)"}`);
}

export function persistMcpRegistryAndEnv(mcp, env) {
  const prevMcpRaw = existsSync(MCP_FILE) ? readFileSync(MCP_FILE, "utf8") : null;
  const prevEnvRaw = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : null;
  try {
    saveJSON(MCP_FILE, mcp);
    saveJSON(ENV_FILE, env);
  } catch (e) {
    if (prevMcpRaw != null) writeFileSync(MCP_FILE, prevMcpRaw);
    if (prevEnvRaw != null) writeFileSync(ENV_FILE, prevEnvRaw);
    throw e;
  }
}

export function clearMcpEnvVars(varNames, env) {
  for (const varName of varNames) {
    if (env[varName]) delete env[varName];
    delete process.env[varName];
  }
}

export function handleMcpRoutes(req, res, url) {
  if (req.method === "GET" && url.pathname === "/mcp") {
    const mcp = loadJSON(MCP_FILE);
    const env = loadJSON(ENV_FILE);
    const view = {};
    for (const [name, entry] of Object.entries(mcp)) {
      const sanitized = sanitizeMcpEntryForDisplay(entry);
      if (usesMcpApiKeyAuth(entry)) {
        sanitized.apiKeyConfigured = isMcpApiKeyConfigured(env, name, mcp);
        sanitized.apiKeyEnv = mcpApiKeyEnvVar(name);
      }
      view[name] = sanitized;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ mcp: view }));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/mcp/add") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        const { name, type, url: mcpUrl, command, environment, headers, enabled = true, auth, apiKeyEnv, apiKeyHeader } = parsed;
        if (Object.prototype.hasOwnProperty.call(parsed, "apiKey")
          && parsed.apiKey != null
          && typeof parsed.apiKey !== "string") {
          throw new Error("apiKey must be a string");
        }
        const apiKeyValue = typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : "";
        if (!name || !type) {
          res.writeHead(400).end(JSON.stringify({ error: "Missing name or type" }));
          return;
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
          res.writeHead(400).end(JSON.stringify({ error: "Invalid name (letters, digits, _ and - only)" }));
          return;
        }
        if (RESERVED_NAMES.has(name)) {
          res.writeHead(400).end(JSON.stringify({ error: "Reserved name" }));
          return;
        }
        const candidate = { type, enabled: !!enabled };
        if (auth === "api_key" || auth === "apikey" || apiKeyValue) candidate.auth = "api_key";
        else if (Object.prototype.hasOwnProperty.call(parsed, "auth")) candidate.auth = auth;
        if (Object.prototype.hasOwnProperty.call(parsed, "apiKeyEnv")) candidate.apiKeyEnv = apiKeyEnv;
        if (Object.prototype.hasOwnProperty.call(parsed, "apiKeyHeader")) candidate.apiKeyHeader = apiKeyHeader;
        if (type === "remote") {
          candidate.url = mcpUrl;
          if (Object.prototype.hasOwnProperty.call(parsed, "headers")) candidate.headers = headers;
        } else if (type === "local") {
          candidate.command = command;
          if (Object.prototype.hasOwnProperty.call(parsed, "environment")) candidate.environment = environment;
        }
        const entry = assertPunchEntry(candidate);
        const mcp = loadJSON(MCP_FILE);
        const env = loadJSON(ENV_FILE);
        mcp[name] = entry;
        let envVar = null;
        let envChanged = false;
        if (!usesMcpApiKeyAuth(entry)) {
          clearMcpEnvVars(mcpApiKeyEnvVarsToClear(name, mcp), env);
          envChanged = true;
        } else if (apiKeyValue) {
          envVar = mcpApiKeyEnvVar(name);
          env[envVar] = apiKeyValue;
          envChanged = true;
        }
        if (envChanged) persistMcpRegistryAndEnv(mcp, env);
        else saveJSON(MCP_FILE, mcp);
        if (envVar) process.env[envVar] = apiKeyValue;
        syncMcpConfig();
        forceRestart();
        res.writeHead(200).end(JSON.stringify({ success: true, name }));
        log(`mcp added: ${name} (${entry.type})`);
      } catch (e) {
        res.writeHead(400).end(JSON.stringify({ error: e?.message || "Invalid JSON" }));
      }
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/mcp/remove") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const { name } = JSON.parse(body);
        if (!name) { res.writeHead(400).end(JSON.stringify({ error: "Missing name" })); return; }
        if (RESERVED_NAMES.has(name)) { res.writeHead(400).end(JSON.stringify({ error: "Reserved name" })); return; }
        const mcp = loadJSON(MCP_FILE);
        if (!mcp[name]) { res.writeHead(404).end(JSON.stringify({ error: "MCP not found" })); return; }
        const env = loadJSON(ENV_FILE);
        const varsToClear = mcpApiKeyEnvVarsToClear(name, mcp);
        clearMcpEnvVars(varsToClear, env);
        delete mcp[name];
        persistMcpRegistryAndEnv(mcp, env);
        syncMcpConfig();
        forceRestart();
        res.writeHead(200).end(JSON.stringify({ success: true }));
      } catch {
        res.writeHead(400).end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/mcp/auth") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const { name, key } = JSON.parse(body);
        if (!name) { res.writeHead(400).end(JSON.stringify({ error: "Missing name" })); return; }
        if (RESERVED_NAMES.has(name)) { res.writeHead(400).end(JSON.stringify({ error: "Reserved name" })); return; }
        if (typeof key !== "string" || !key.trim()) {
          res.writeHead(400).end(JSON.stringify({ error: "Missing API key" }));
          return;
        }
        const mcp = loadJSON(MCP_FILE);
        if (!mcp[name]) { res.writeHead(404).end(JSON.stringify({ error: "MCP not found" })); return; }
        mcp[name] = assertPunchEntry({ ...mcp[name], auth: "api_key" });
        const envVar = mcpApiKeyEnvVar(name);
        const env = loadJSON(ENV_FILE);
        env[envVar] = key.trim();
        persistMcpRegistryAndEnv(mcp, env);
        process.env[envVar] = key.trim();
        syncMcpConfig();
        forceRestart();
        res.writeHead(200).end(JSON.stringify({ success: true, apiKeyEnv: envVar }));
        log(`mcp api key set for: ${name}`);
      } catch (e) {
        res.writeHead(400).end(JSON.stringify({ error: e?.message || "Invalid JSON" }));
      }
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/mcp/logout") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const { name } = JSON.parse(body);
        if (!name) { res.writeHead(400).end(JSON.stringify({ error: "Missing name" })); return; }
        if (RESERVED_NAMES.has(name)) { res.writeHead(400).end(JSON.stringify({ error: "Reserved name" })); return; }
        const mcp = loadJSON(MCP_FILE);
        if (!mcp[name]) { res.writeHead(404).end(JSON.stringify({ error: "MCP not found" })); return; }
        const env = loadJSON(ENV_FILE);
        clearMcpEnvVars(mcpApiKeyEnvVarsToClear(name, mcp), env);
        saveJSON(ENV_FILE, env);
        syncMcpConfig();
        forceRestart();
        res.writeHead(200).end(JSON.stringify({ success: true }));
        log(`mcp api key removed for: ${name}`);
      } catch {
        res.writeHead(400).end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/mcp/oauth") {
    res.writeHead(501, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: "MCP OAuth not available yet — use /mcp auth for API keys, or pass custom headers/environment on add",
    }));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/mcp/oauth/logout") {
    res.writeHead(501, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: "MCP OAuth logout not available yet — use /mcp logout for API keys",
    }));
    return true;
  }

  return false;
}
