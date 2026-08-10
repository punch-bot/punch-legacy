// Strips <remember>/<forget> tags from model output and applies them to memory.

import * as store from "../memory.js";

const REMEMBER_RE =
  /<remember(?:\s+scope="(user|channel)")?(?:\s+id="(\d+)")?\s*>([\s\S]*?)<\/remember>/gi;
const FORGET_RE = /<forget\s+id="([^"]+)"\s*>\s*<\/forget>/gi;

export function persistMemoryTags(textIn, speakerId, channelId) {
  let saved = 0;
  let dropped = 0;
  const text = String(textIn || "");

  for (const m of text.matchAll(REMEMBER_RE)) {
    const scope = (m[1] || "user").toLowerCase();
    const fact = m[3].trim();
    if (!fact) continue;
    if (scope === "channel") store.remember("channel", channelId, fact);
    else store.remember("user", m[2] || speakerId, fact);
    saved += 1;
  }

  for (const m of text.matchAll(FORGET_RE)) {
    const id = m[1].trim();
    if (store.forget("user", speakerId, id) || store.forget("channel", channelId, id)) {
      dropped += 1;
    }
  }

  const clean = text.replace(REMEMBER_RE, "").replace(FORGET_RE, "").trim();
  return { clean, saved, dropped };
}
