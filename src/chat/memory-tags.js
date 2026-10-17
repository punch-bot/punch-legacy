// Strip tags even if a memory operation fails, so an annotation cannot discard
// an otherwise successful reply. Report only writes that actually persisted.

import * as store from "../memory.js";

const REMEMBER_RE =
  /<remember(?:\s+scope="(user|channel)")?(?:\s+id="(\d+)")?\s*>([\s\S]*?)<\/remember>/gi;
const FORGET_RE = /<forget\s+id="([^"]+)"\s*>\s*<\/forget>/gi;

export function persistMemoryTags(textIn, speakerId, channelId) {
  let saved = 0;
  let dropped = 0;
  let failed = 0;
  const text = String(textIn || "");

  for (const m of text.matchAll(REMEMBER_RE)) {
    const scope = (m[1] || "user").toLowerCase();
    const fact = m[3].trim();
    if (!fact) continue;
    try {
      if (scope === "channel") {
        // No channel context (e.g. heartbeat DM) — channel facts have no home.
        if (!channelId) continue;
        store.remember("channel", channelId, fact);
        saved += 1;
      } else {
        store.remember("user", speakerId, fact);
        saved += 1;
      }
    } catch (error) {
      failed += 1;
      console.warn(`[memory] remember tag failed: ${error.code || error.name || "write error"}`);
    }
  }

  for (const m of text.matchAll(FORGET_RE)) {
    const id = m[1].trim();
    try {
      if (store.forget("user", speakerId, id) || (channelId && store.forget("channel", channelId, id))) {
        dropped += 1;
      }
    } catch (error) {
      failed += 1;
      console.warn(`[memory] forget tag failed: ${error.code || error.name || "write error"}`);
    }
  }

  const clean = text.replace(REMEMBER_RE, "").replace(FORGET_RE, "").trim();
  return { clean, saved, dropped, failed };
}
