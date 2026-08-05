/**
 * Punch MCP registry (/data/mcp.json) ↔ pi-mcp-adapter mcpServers conversion.
 * Registry keeps OpenCode-shaped local/remote entries; adapter wants mcpServers.
 */

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
    const out = { type: "remote", enabled, url };
    if (headers && Object.keys(headers).length) out.headers = headers;
    return out;
  }
  const command = normalizeLocalCommand(entry.command);
  const hasEnvField = Object.prototype.hasOwnProperty.call(entry, "environment");
  const environment = hasEnvField
    ? asStringRecord(entry.environment, "environment")
    : undefined;
  const out = { type: "local", enabled, command };
  if (environment && Object.keys(environment).length) out.environment = environment;
  return out;
}

/**
 * Convert one Punch registry entry to a pi-mcp-adapter ServerEntry.
 * @param {object} entry
 * @returns {object|null} null if entry is invalid
 */
export function punchEntryToAdapter(entry) {
  try {
    const normalized = assertPunchEntry(entry);
    const disabled = normalized.enabled === false;
    if (normalized.type === "remote") {
      const out = {
        url: normalized.url,
        // Punch Discord sandboxes have no interactive OAuth UI yet.
        auth: false,
      };
      if (normalized.headers) out.headers = normalized.headers;
      if (disabled) out.disabled = true;
      return out;
    }
    const out = {
      command: normalized.command[0],
      args: normalized.command.slice(1),
      cwd: "/work",
    };
    if (normalized.environment) out.env = normalized.environment;
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
      const adapted = punchEntryToAdapter(entry);
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
