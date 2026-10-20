import * as store from "../memory.js";

const REMEMBER_RE = /<remember((?:\s+[a-z]+="[^"]*")*)\s*>([\s\S]*?)<\/remember>/gi;
const ATTRIBUTE_RE = /([a-z]+)="([^"]*)"/gi;
const FORGET_RE = /<forget\s+id="([^"]+)"\s*>\s*<\/forget>/gi;

export function persistMemoryTags(textIn, speakerId, channelId) {
  let saved = 0;
  let dropped = 0;
  let failed = 0;
  const text = String(textIn || "");

  for (const m of text.matchAll(REMEMBER_RE)) {
    const attributes = Object.fromEntries([...m[1].matchAll(ATTRIBUTE_RE)].map(([, name, value]) => [name.toLowerCase(), value.trim()]));
    const scope = (attributes.scope || "user").toLowerCase();
    const fact = m[2].trim();
    if (!fact || !["user", "channel"].includes(scope)) continue;
    try {
      const replaces = attributes.replaces;
      if (replaces && (store.reviseMemory("user", speakerId, replaces, fact) ||
          (channelId && store.reviseMemory("channel", channelId, replaces, fact)))) {
        saved += 1;
      } else if (scope === "channel") {
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
