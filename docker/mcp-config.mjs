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

/**
 * Convert one Punch registry entry to a pi-mcp-adapter ServerEntry.
 * @param {object} entry
 * @returns {object|null} null if entry is invalid
 */
export function punchEntryToAdapter(entry) {
  if (!entry || typeof entry !== "object") return null;
  const type = entry.type;
  const disabled = entry.enabled === false;
  if (type === "remote") {
    if (typeof entry.url !== "string" || !entry.url.trim()) return null;
    const headers = entry.headers
      ? asStringRecord(entry.headers, "headers")
      : undefined;
    const out = {
      url: entry.url.trim(),
      // Punch Discord sandboxes have no interactive OAuth UI yet.
      auth: false,
    };
    if (headers && Object.keys(headers).length) out.headers = headers;
    if (disabled) out.disabled = true;
    return out;
  }
  if (type === "local") {
    let argv = entry.command;
    if (typeof argv === "string") argv = splitCommandString(argv);
    if (!Array.isArray(argv) || argv.length === 0) return null;
    if (!argv.every((p) => typeof p === "string" && p.length > 0)) return null;
    const env = entry.environment
      ? asStringRecord(entry.environment, "environment")
      : undefined;
    const out = {
      command: argv[0],
      args: argv.slice(1),
      cwd: "/work",
    };
    if (env && Object.keys(env).length) out.env = env;
    if (disabled) out.disabled = true;
    return out;
  }
  return null;
}

/**
 * @param {Record<string, object>} registry Punch /data/mcp.json map
 * @returns {Record<string, object>} adapter mcpServers map
 */
export function punchRegistryToMcpServers(registry) {
  const mcpServers = {};
  if (!registry || typeof registry !== "object") return mcpServers;
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
