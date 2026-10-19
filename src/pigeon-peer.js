import dns from "node:dns/promises";

export function normalizePeerHostname(h) {
  if (!h) return "";
  return String(h).toLowerCase().split(".")[0];
}

export function parseSandboxFromHostname(h) {
  const host = normalizePeerHostname(h);
  if (!host) return null;
  let m = host.match(/^sandbox-(.+)$/);
  if (m) return m[1];
  m = host.match(/^[a-z0-9_-]+_sandbox-(.+)_\d+$/);
  if (m) return m[1];
  m = host.match(/^punch-sandbox-(.+)-\d+$/);
  if (m) return m[1];
  return null;
}

export function isBotPeer(hostname) {
  const h = normalizePeerHostname(hostname);
  if (!h) return false;
  if (h === "bot") return true;
  if (h.includes("_sandbox-") || h.startsWith("sandbox-") || h.startsWith("punch-sandbox-")) {
    return false;
  }
  if (/^punch[-_]?bot([-_]\d+)?$/.test(h)) return true;
  if (/^[a-z0-9_-]+-bot(-\d+)?$/.test(h)) return true;
  return false;
}

export function peerIp(req) {
  let ip = req.socket?.remoteAddress || "";
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  return ip;
}

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
  } catch {}
  try {
    const botAddresses = await dns.lookup("bot", { all: true });
    if (botAddresses.some((entry) => entry.address === ip)) return { peer: "bot" };
  } catch {}
  return null;
}

export function isRegisteredSandboxName(name, users) {
  if (!name || !Array.isArray(users)) return false;
  return users.some((u) => u.name === name);
}
