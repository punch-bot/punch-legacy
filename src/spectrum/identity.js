export function normalizeAddressKey(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  if (s.includes("@")) return s.toLowerCase();
  const digits = s.replace(/[^\d+]/g, "");
  if (!digits) return s.toLowerCase();
  if (digits.startsWith("+")) return digits;
  return `+${digits}`;
}

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

export function resolvePunchUserId(sender, config, extra = null, options = {}) {
  const map = config.userMap && typeof config.userMap === "object" ? config.userMap : {};
  for (const key of senderLookupKeys(sender, extra)) {
    if (map[key]) return map[key];
    const normalized = normalizeAddressKey(key);
    if (normalized && map[normalized]) return map[normalized];
  }
  for (const key of senderLookupKeys(sender, extra)) {
    for (const [mapKey, userId] of Object.entries(map)) {
      if (normalizeAddressKey(mapKey) === normalizeAddressKey(key) && userId) {
        return userId;
      }
    }
  }
  if (options.allowDefault && config.defaultUserId) {
    return String(config.defaultUserId);
  }
  return null;
}
