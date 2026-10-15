/**
 * Punch MCP registry (/data/mcp.json) and normalized mcpServers conversion.
 * Registry keeps `local`/`remote` entries; adapter wants mcpServers.
 */

import { Buffer } from "node:buffer";

/** Legacy env var normalization (collides on hyphen vs underscore). Kept for migration only. */
export function legacyMcpApiKeyEnvVar(serverName) {
  const safe = String(serverName || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return `MCP_${safe || "SERVER"}_API_KEY`;
}

/** Collision-free env var for a stored MCP API key (lossless base64url of server name). */
export function mcpApiKeyEnvVar(serverName) {
  const raw = String(serverName || "").trim();
  if (!raw) return "MCP_SERVER_API_KEY";
  const encoded = Buffer.from(raw, "utf8").toString("base64url");
  return `MCP_${encoded}_API_KEY`;
}

/** All env var names that may hold a key for this server (new + legacy). */
export function mcpApiKeyEnvVarCandidates(serverName) {
  const candidates = [mcpApiKeyEnvVar(serverName)];
  const legacy = legacyMcpApiKeyEnvVar(serverName);
  if (legacy !== candidates[0]) candidates.push(legacy);
  return candidates;
}

/** Env vars safe to delete for one server (skips ambiguous shared legacy names). */
export function mcpApiKeyEnvVarsToClear(serverName, registry) {
  const toClear = [mcpApiKeyEnvVar(serverName)];
  const legacyVar = legacyMcpApiKeyEnvVar(serverName);
  const newVar = toClear[0];
  if (legacyVar !== newVar) {
    const owners = legacyMcpApiKeyOwners(registry)[legacyVar];
    if ((owners?.length || 0) <= 1) toClear.push(legacyVar);
  }
  return toClear;
}

/** Split a Discord space-separated command string into argv (supports simple quotes). */
export function splitCommandString(input) {
  const s = String(input || "").trim();
  if (!s) return [];
  const out = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && i + 1 < s.length) {
        cur += s[++i];
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    if (ch === "\\" && i + 1 < s.length) {
      cur += s[++i];
      continue;
    }
    cur += ch;
  }
  if (quote) throw new Error("Unclosed quote in command");
  if (cur) out.push(cur);
  return out;
}

function asStringRecord(value, label) {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") {
      throw new Error(`${label}.${k} must be a string`);
    }
    out[k] = v;
  }
  return out;
}

function normalizeLocalCommand(command) {
  let argv = command;
  if (typeof argv === "string") argv = splitCommandString(argv);
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error("Local MCP requires a non-empty command array");
  }
  if (!argv.every((p) => typeof p === "string" && p.length > 0)) {
    throw new Error("Local MCP command entries must be non-empty strings");
  }
  return argv;
}

function usesApiKeyAuth(entry) {
  return entry.auth === "api_key" || entry.auth === "apikey" || entry.apiKey === true;
}

export function usesMcpApiKeyAuth(entry) {
  return usesApiKeyAuth(entry);
}

/** Map legacy env var names to registry server names that share them. */
export function legacyMcpApiKeyOwners(registry) {
  const legacyOwners = {};
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) return legacyOwners;
  for (const name of Object.keys(registry)) {
    const legacyVar = legacyMcpApiKeyEnvVar(name);
    const newVar = mcpApiKeyEnvVar(name);
    if (legacyVar === newVar) continue;
    if (!legacyOwners[legacyVar]) legacyOwners[legacyVar] = [];
    legacyOwners[legacyVar].push(name);
  }
  return legacyOwners;
}

/** Migrate legacy MCP key env vars to collision-free names. */
export function migrateMcpApiKeyEnvVars(registry, env) {
  const out = { ...env };
  let changed = false;
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    return { env: out, changed };
  }
  const legacyOwners = legacyMcpApiKeyOwners(registry);
  for (const name of Object.keys(registry)) {
    const newVar = mcpApiKeyEnvVar(name);
    const legacyVar = legacyMcpApiKeyEnvVar(name);
    if (legacyVar === newVar) continue;
    if ((legacyOwners[legacyVar]?.length || 0) > 1) continue;
    if (out[legacyVar] && !out[newVar]) {
      out[newVar] = out[legacyVar];
      delete out[legacyVar];
      changed = true;
    }
  }
  return { env: out, changed };
}

/** Redact MCP API key values from a public env view. */
export function redactMcpKeysFromEnvView(env) {
  const view = { ...env };
  for (const [k, v] of Object.entries(view)) {
    if (k.startsWith("MCP_") && k.endsWith("_API_KEY") && v) view[k] = "(set)";
  }
  return view;
}

export function isMcpApiKeyConfigured(env, serverName, registry) {
  if (!env || typeof env !== "object") return false;
  const newVar = mcpApiKeyEnvVar(serverName);
  if (env[newVar]) return true;
  const legacyVar = legacyMcpApiKeyEnvVar(serverName);
  if (legacyVar === newVar) return false;
  if (registry) {
    const owners = legacyMcpApiKeyOwners(registry)[legacyVar];
    if ((owners?.length || 0) > 1) return false;
  }
  return !!env[legacyVar];
}

/** Public view of a registry entry (no secret headers or inline keys). */
export function sanitizeMcpEntryForDisplay(entry) {
  if (!entry || typeof entry !== "object") return entry;
  const out = { ...entry };
  if (out.headers && typeof out.headers === "object") {
    const headers = { ...out.headers };
    for (const k of Object.keys(headers)) {
      if (headers[k]) headers[k] = "(set)";
    }
    out.headers = headers;
  }
  delete out.apiKey;
  return out;
}

/**
 * Strict validation for /mcp/add. Throws on invalid shapes.
 * Returns a normalized Punch registry entry ready to persist.
 */
export function assertPunchEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("MCP entry must be an object");
  }
  const type = entry.type;
  if (type !== "local" && type !== "remote") {
    throw new Error("type must be 'local' or 'remote'");
  }
  const enabled = entry.enabled !== false;
  const authMode = entry.auth;
  const apiKeyAuth = authMode === "api_key" || authMode === "apikey" || entry.apiKey === true;
  if (authMode != null && authMode !== "api_key" && authMode !== "apikey") {
    throw new Error("auth must be 'api_key' when set");
  }
  if (entry.apiKeyEnv != null) {
    const envName = String(entry.apiKeyEnv || "").trim();
    if (!envName || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
      throw new Error("apiKeyEnv must be a valid env var name (letters, digits, underscore)");
    }
  }
  if (entry.apiKeyHeader != null) {
    const headerName = String(entry.apiKeyHeader || "").trim();
    if (!headerName) throw new Error("apiKeyHeader must be a non-empty header name");
  }
  if (type === "remote") {
    if (typeof entry.url !== "string" || !entry.url.trim()) {
      throw new Error("Missing url for remote MCP");
    }
    const url = entry.url.trim();
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("Invalid remote MCP url");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Remote MCP url must use http:// or https://");
    }
    // Preserve explicitly supplied headers (including empty object) for validation.
    const hasHeadersField = Object.prototype.hasOwnProperty.call(entry, "headers");
    const headers = hasHeadersField
      ? asStringRecord(entry.headers, "headers")
      : undefined;
    if (headers && Object.keys(headers).length > 0 && parsed.protocol !== "https:") {
      throw new Error("Credentialed remote MCP requires an https:// url");
    }
    if (apiKeyAuth && parsed.protocol !== "https:") {
      throw new Error("API key auth for remote MCP requires an https:// url");
    }
    const out = { type: "remote", enabled, url };
    if (apiKeyAuth) out.auth = "api_key";
    if (entry.apiKeyHeader) out.apiKeyHeader = String(entry.apiKeyHeader).trim();
    if (headers && Object.keys(headers).length) out.headers = headers;
    return out;
  }
  const command = normalizeLocalCommand(entry.command);
  const hasEnvField = Object.prototype.hasOwnProperty.call(entry, "environment");
  const environment = hasEnvField
    ? asStringRecord(entry.environment, "environment")
    : undefined;
  const out = { type: "local", enabled, command };
  if (apiKeyAuth) out.auth = "api_key";
  if (entry.apiKeyEnv) out.apiKeyEnv = String(entry.apiKeyEnv).trim();
  if (environment && Object.keys(environment).length) out.environment = environment;
  return out;
}

function applyApiKeyAuthToAdapter(out, entry, serverName) {
  const envVar = mcpApiKeyEnvVar(serverName);
  const ref = `\${${envVar}}`;
  if (out.headers) {
    out.headers = stripCredentialHeaders(out.headers);
    if (!Object.keys(out.headers).length) delete out.headers;
  }
  if (entry.type === "remote") {
    const headerName = entry.apiKeyHeader ? String(entry.apiKeyHeader).trim() : "";
    if (headerName && headerName.toLowerCase() !== "authorization") {
      out.headers = { ...(out.headers || {}), [headerName]: ref };
      return out;
    }
    out.auth = "bearer";
    out.bearerTokenEnv = envVar;
    return out;
  }
  const targetEnv = entry.apiKeyEnv ? String(entry.apiKeyEnv).trim() : "API_KEY";
  out.env = { ...(out.env || {}), [targetEnv]: ref };
  return out;
}

function stripCredentialHeaders(headers) {
  const out = { ...headers };
  for (const k of Object.keys(out)) {
    const h = k.toLowerCase();
    if (h === "authorization" || h === "x-api-key" || h.endsWith("-api-key") || h.includes("token")) {
      delete out[k];
    }
  }
  return out;
}

/**
 * Convert one Punch registry entry to a normalized MCP server entry.
 * @param {object} entry
 * @param {string} [serverName] registry key (required for api_key auth wiring)
 * @returns {object|null} null if entry is invalid
 */
export function punchEntryToAdapter(entry, serverName) {
  try {
    const normalized = assertPunchEntry(entry);
    const disabled = normalized.enabled === false;
    if (normalized.type === "remote") {
      let out = {
        url: normalized.url,
      };
      if (!usesApiKeyAuth(normalized)) {
        // Punch Discord sandboxes have no interactive OAuth UI yet.
        out.auth = false;
      }
      if (normalized.headers) out.headers = normalized.headers;
      if (usesApiKeyAuth(normalized) && serverName) {
        out = applyApiKeyAuthToAdapter(out, normalized, serverName);
      }
      if (disabled) out.disabled = true;
      return out;
    }
    let out = {
      command: normalized.command[0],
      args: normalized.command.slice(1),
      cwd: "/work",
    };
    if (normalized.environment) out.env = normalized.environment;
    if (usesApiKeyAuth(normalized) && serverName) {
      out = applyApiKeyAuthToAdapter(out, normalized, serverName);
    }
    if (disabled) out.disabled = true;
    return out;
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, object>} registry Punch /data/mcp.json map
 * @returns {Record<string, object>} adapter mcpServers map
 */
export function punchRegistryToMcpServers(registry) {
  const mcpServers = {};
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    return mcpServers;
  }
  for (const [name, entry] of Object.entries(registry)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) continue;
    try {
      const adapted = punchEntryToAdapter(entry, name);
      if (adapted) mcpServers[name] = adapted;
    } catch {
      // Skip malformed entries so one bad server does not block the rest.
    }
  }
  return mcpServers;
}

/** Adapter-shaped root config written to /data/pi/agent/mcp.json for ops/debug. */
export function punchRegistryToAdapterConfig(registry) {
  return {
    mcpServers: punchRegistryToMcpServers(registry),
    settings: {
      // Headless Discord sandbox: never attempt browser OAuth auto-flow.
      autoAuth: false,
      hostConfigDiscovery: "off",
    },
  };
}
