/**
 * Map Spectrum senders to Punch sandbox user IDs (same IDs as /sandbox create).
 */

/**
 * Normalize phone-like addresses for map lookup (+digits).
 * @param {string} value
 */
export function normalizeAddressKey(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  if (s.includes("@")) return s.toLowerCase();
  const digits = s.replace(/[^\d+]/g, "");
  if (!digits) return s.toLowerCase();
  if (digits.startsWith("+")) return digits;
  return digits;
}

/**
 * Collect candidate keys from a Spectrum message sender / platform fields.
 * @param {{ id?: string, address?: string } | null | undefined} sender
 * @param {{ address?: string } | null | undefined} [extra]
 * @returns {string[]}
 */
export function senderLookupKeys(sender, extra = null) {
  const raw = [];
  if (sender?.id) raw.push(String(sender.id));
  if (sender?.address) raw.push(String(sender.address));
  if (extra?.address) raw.push(String(extra.address));
  const keys = [];
  const seen = new Set();
  for (const value of raw) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    for (const candidate of [trimmed, normalizeAddressKey(trimmed)]) {
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      keys.push(candidate);
    }
  }
  return keys;
}

/**
 * Resolve Punch userId for an inbound Spectrum message.
 * @param {{ id?: string, address?: string } | null | undefined} sender
 * @param {{ defaultUserId?: string, userMap?: Record<string, string> }} config
 * @param {{ address?: string } | null | undefined} [extra]
 * @returns {string | null}
 */
export function resolvePunchUserId(sender, config, extra = null) {
  const map = config.userMap && typeof config.userMap === "object" ? config.userMap : {};
  for (const key of senderLookupKeys(sender, extra)) {
    if (map[key]) return map[key];
    const normalized = normalizeAddressKey(key);
    if (normalized && map[normalized]) return map[normalized];
  }
  // Also try map keys against normalized forms of map itself (caller may store +E.164).
  for (const key of senderLookupKeys(sender, extra)) {
    for (const [mapKey, userId] of Object.entries(map)) {
      if (normalizeAddressKey(mapKey) === normalizeAddressKey(key) && userId) {
        return userId;
      }
    }
  }
  return config.defaultUserId ? String(config.defaultUserId) : null;
}
