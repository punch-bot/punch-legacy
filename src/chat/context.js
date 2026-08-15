// Thread- and channel-scoped context isolation. Pure helpers (no Discord
// client needed) plus the fetch functions used to build turn context.

import { sandboxNameForUser } from "../agent.js";
import { THREAD_WINDOW, RESIDUE_LIMIT } from "../core/config.js";
import { PREFIX } from "../core/config.js";
import { registry } from "../core/registry.js";
import { setSecret, getSecrets } from "../agent.js";

// messages: Array<{ id: string, referenceMessageId: string | null }>
// rootId: string
// Returns a Set<id> of every message whose reply chain (walking
// message.reference upward) reaches rootId. rootId is always included, even if
// it isn't present in `messages`.
export function filterThreadSubtree(messages, rootId) {
  const parentOf = new Map();
  for (const m of messages) {
    if (m && m.referenceMessageId) parentOf.set(m.id, m.referenceMessageId);
  }
  const reachesRoot = (id) => {
    const seen = new Set();
    let cur = id;
    while (cur && !seen.has(cur)) {
      if (cur === rootId) return true;
      seen.add(cur);
      cur = parentOf.get(cur);
    }
    return false;
  };
  const out = new Set();
  for (const m of messages) {
    if (m && reachesRoot(m.id)) out.add(m.id);
  }
  out.add(rootId);
  return out;
}

export async function fetchChannelContext(channel, beforeId, currentSandboxName = null) {
  if (!channel) return [];
  try {
    const fetched = await channel.messages.fetch({ limit: 15, before: beforeId });
    return fetched
      .map((m) => mapContextMsg(m, currentSandboxName))
      .filter((m) => m && m.content.length > 0)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .slice(-15);
  } catch (err) {
    console.error("[context] failed to fetch recent messages:", err.message);
    return [];
  }
}

// Walk a message's reply chain upward to find the root of its thread.
// Caps at 12 hops; fetches each parent individually.
// v2: batch these individual fetches into one bulk fetch if it ever feels slow.
async function resolveRoot(channel, startId) {
  let cur = await channel.messages.fetch(startId).catch(() => null);
  if (!cur) return null;
  let hops = 0;
  while (cur.reference?.messageId && hops < 12) {
    const parentId = cur.reference.messageId;
    const parent = await channel.messages.fetch(parentId).catch(() => null);
    if (!parent) break;
    cur = parent;
    hops += 1;
  }
  return cur;
}

// Map a Discord message into the { author, content } context shape.
// Human messages are tagged by display name. Bot messages are other punches'
// output: we strip the `-# from sandbox:NAME` footer, attribute them as
// `[punch:NAME]`, and skip the summoner's OWN prior output (the Pi
// session already carries it). Attributed punch output lets one punch SEE what
// another punch did in the thread without mistaking it for a command.
function mapContextMsg(m, currentSandboxName) {
  const raw = m.content.replace(/<@!?\d+>/g, "").trim();
  if (m.author.bot) {
    const m2 = raw.match(/-#\s*from sandbox:(\S+)/i);
    const name = m2 ? m2[1] : null;
    const content = raw.replace(/-#\s*from sandbox:\S+/i, "").trim().slice(0, 200);
    if (!content) return null;
    if (name && currentSandboxName && name.toLowerCase() === currentSandboxName.toLowerCase()) {
      return null; // own prior output — session history already has it
    }
    // Known Punch sandboxes are tagged `punch:NAME`; foreign bots (no sandbox
    // footer) are attributed by their own display name so context isn't
    // mislabeled as a Punch.
    const author = name ? `punch:${name}` : (m.member?.displayName || m.author.username);
    return { author, content };
  }
  return {
    author: m.member?.displayName || m.author.username,
    content: raw.slice(0, 200),
  };
}

// Thread-scoped context: ingest only the reply subtree rooted at the summoning
// message's root. Humans are always visible; other punches' output is included
// (attributed as `[punch:NAME]`) so the summoning punch can see what its
// neighbours are doing, while its OWN prior output is skipped to avoid loops.
export async function fetchThreadContext(channel, message, opts = {}) {
  if (!channel) return [];
  const currentSandboxName = sandboxNameForUser(opts.userId) || null;
  try {
    const root = await resolveRoot(channel, message.id);
    if (!root) {
      return fetchChannelContext(channel, message.id, currentSandboxName).slice(-RESIDUE_LIMIT);
    }

    const fetched = await channel.messages.fetch({ limit: THREAD_WINDOW, before: message.id });
    const all = [root, ...fetched.values()];
    const mapped = all.map((m) => ({ id: m.id, referenceMessageId: m.reference?.messageId || null }));
    const keep = filterThreadSubtree(mapped, root.id);
    const kept = all
      .filter((m) => keep.has(m.id))
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map((m) => mapContextMsg(m, currentSandboxName))
      .filter((m) => m && m.content.length > 0);
    let result = kept;

    // Non-reply ping (root == the summon itself): no thread has formed yet, so
    // add a small ambient residue of recent human messages for context.
    if (root.id === message.id && result.length <= 1) {
      const residue = fetchChannelContext(channel, message.id, currentSandboxName).slice(-RESIDUE_LIMIT);
      result = result.concat(residue);
    }

    // Cross-ping escape hatch: a Discord message link in the summon pulls that
    // other thread's messages into context too (bot output attributed as
    // [punch:NAME], outputs stay distinct).
    // v2: also scan message.reference for linked messages, and support multiple links.
    const linkMatch = message.content.match(/discord\.com\/channels\/\d+\/\d+\/(\d+)/);
    if (linkMatch) {
      const linked = await channel.messages.fetch(linkMatch[1]).catch(() => null);
      if (linked) {
        const linkedRoot = await resolveRoot(channel, linked.id);
        if (linkedRoot) {
          const lfetched = await channel.messages.fetch({ limit: THREAD_WINDOW, before: message.id });
          const lall = [linkedRoot, ...lfetched.values()];
          const lmapped = lall.map((m) => ({ id: m.id, referenceMessageId: m.reference?.messageId || null }));
          const lkeep = filterThreadSubtree(lmapped, linkedRoot.id);
          const lkept = lall
            .filter((m) => lkeep.has(m.id) && m.id !== message.id)
            .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
            .map((m) => mapContextMsg(m, currentSandboxName))
            .filter((m) => m && m.content.length > 0);
          result = result.concat(lkept);
        }
      }
    }

    return result.slice(-THREAD_WINDOW);
  } catch (err) {
    console.error("[context] thread fetch failed:", err.message);
    return [];
  }
}

export function progressSettingsFor(message) {
  // Lifecycle reactions (👀 → ✅/🛑/⚠️) were removed — the bot only reacts via
  // the model's <react> tags now. Progress is always the live status message,
  // so `reactionProgressEnabled` / `reactionProgressMode` are kept as inert
  // config for compatibility.
  return { useThinking: true };
}

export const settingsDeps = () => ({
  prefix: PREFIX,
  botUsername: registry.client?.user?.username || "Punch",
  setSecret,
  getSecrets,
});
