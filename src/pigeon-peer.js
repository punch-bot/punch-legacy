import dns from "node:dns/promises";

/** Strip Docker network domain suffix (e.g. punch_sandbox-ember_1.punch_edge). */
export function normalizePeerHostname(h) {
  if (!h) return "";
  return String(h).toLowerCase().split(".")[0];
}

/**
 * Match sandbox-<name>, {stack}_sandbox-<name>_<n>, or punch-sandbox-<name>-<n>.
 * Covers prod (`punch_sandbox-ember_1`) and Nightly (`punch-nightly_sandbox-ember_1`).
 */
export function parseSandboxFromHostname(h) {
  const host = normalizePeerHostname(h);
  if (!host) return null;
  let m = host.match(/^sandbox-(.+)$/);
  if (m) return m[1];
  // Compose/dynamic: punch_sandbox-ember_1, punch-nightly_sandbox-ember_1
  m = host.match(/^[a-z0-9_-]+_sandbox-(.+)_\d+$/);
  if (m) return m[1];
  m = host.match(/^punch-sandbox-(.+)-\d+$/);
  if (m) return m[1];
  return null;
}

/** True when hostname is the bot service (compose or plain). */
export function isBotPeer(hostname) {
  const h = normalizePeerHostname(hostname);
  if (!h) return false;
  if (h === "bot") return true;
  // Sandbox containers must never count as bot (e.g. sandbox named "bot")
  if (h.includes("_sandbox-") || h.startsWith("sandbox-") || h.startsWith("punch-sandbox-")) {
    return false;
  }
  // punch-bot, punch-bot-1, punch_bot_1
  if (/^punch[-_]?bot([-_]\d+)?$/.test(h)) return true;
  // Compose project bot: punch-nightly-bot-1, punch-nightly-bot
  if (/^[a-z0-9_-]+-bot(-\d+)?$/.test(h)) return true;
  return false;
}

export function peerIp(req) {
  let ip = req.socket?.remoteAddress || "";
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  return ip;
}

/**
 * Resolve the pigeon peer from the HTTP connection.
 * @returns {Promise<{ peer: "sandbox", name: string } | { peer: "bot" } | null>}
 */
export async function resolvePeerSandbox(req, { loopbackName } = {}) {
  const ip = peerIp(req);
  if (!ip) return null;
  if (ip === "127.0.0.1" || ip === "::1") {
    const name = loopbackName || process.env.SANDBOX_NAME;
    return name ? { peer: "sandbox", name } : null;
  }
  try {
    const hostnames = await dns.reverse(ip);
    for (const h of hostnames) {
      if (isBotPeer(h)) return { peer: "bot" };
      const name = parseSandboxFromHostname(h);
      if (name) return { peer: "sandbox", name };
    }
  } catch {
    // Reverse DNS may be unavailable on some Docker versions; compare the
    // connection address with the bot service's forward lookup as fallback.
  }
  try {
    const botAddresses = await dns.lookup("bot", { all: true });
    if (botAddresses.some((entry) => entry.address === ip)) return { peer: "bot" };
  } catch {}
  return null;
}

/** Bot-side: ensure `from` is a registered sandbox user name. */
export function isRegisteredSandboxName(name, users) {
  if (!name || !Array.isArray(users)) return false;
  return users.some((u) => u.name === name);
}
