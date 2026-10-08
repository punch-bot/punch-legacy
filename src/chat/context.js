// Thread- and channel-scoped context isolation. Pure helpers (no Discord
// client needed) plus the fetch functions used to build turn context.
// Channel-mode fetching and message mapping live in ../channel-context.js.

import * as store from "../memory.js";
import { sandboxNameForUser } from "../agent.js";
import { fetchChannelContext, mapContextMessage } from "../channel-context.js";
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

// Thread-scoped context: ingest only the reply subtree rooted at the summoning
// message's root. The subtree is the summoning user's own reply chain, so it
// may include the neighbours it explicitly engaged with (other humans and other
// punches' output, attributed as `[punch:NAME]`), while its OWN prior output is
// skipped to avoid loops. The ambient residue fallback below is scoped to the
// summoning user only (own messages + explicit references).
export async function fetchThreadContext(channel, message, opts = {}) {
  if (!channel) return [];
  const currentSandboxName = sandboxNameForUser(opts.userId) || null;
  const timeZone = store.getUserSettings(opts.userId).timeZone;
  try {
    const root = await resolveRoot(channel, message.id);
    if (!root) {
      return fetchChannelContext(channel, message, {
        currentSandboxName, userId: opts.userId, timeZone, limit: RESIDUE_LIMIT,
      });
    }

    const fetched = await channel.messages.fetch({ limit: THREAD_WINDOW, before: message.id });
    const all = [...new Map([root, ...fetched.values()].map((m) => [m.id, m])).values()];
    const mapped = all.map((m) => ({ id: m.id, referenceMessageId: m.reference?.messageId || null }));
    const keep = filterThreadSubtree(mapped, root.id);
    const kept = all
      .filter((m) => keep.has(m.id) && m.id !== message.id)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map((m) => mapContextMessage(m, currentSandboxName, timeZone))
      .filter((m) => m && m.content.length > 0);
    let result = kept;

    // Non-reply ping (root == the summon itself): no thread has formed yet, so
    // add a small residue of recent messages for context. Like channel mode,
    // the residue is scoped to the summoning user (own messages + explicit
    // references) so other users' jobs never leak in.
    if (root.id === message.id && result.length === 0) {
      const residue = await fetchChannelContext(channel, message, {
        currentSandboxName, userId: opts.userId, timeZone, limit: RESIDUE_LIMIT,
      });
      result = result.concat(residue);
    }

    // Cross-ping escape hatch: a Discord message link in the summon pulls that
    // other thread's messages into context too (bot output attributed as
    // [punch:NAME], outputs stay distinct).
    // v2: also scan message.reference for linked messages, and support multiple links.
    const linkMatch = message.content.match(/discord\.com\/channels\/\d+\/(\d+)\/(\d+)/);
    if (linkMatch) {
      const linkedChannelId = linkMatch[1];
      const linkedMessageId = linkMatch[2];
      const linkChannel =
        linkedChannelId && linkedChannelId !== channel.id
          ? await registry.client.channels.fetch(linkedChannelId).catch(() => null)
          : channel;
      if (!linkChannel?.isTextBased?.()) return result.slice(-THREAD_WINDOW);
      const linked = await linkChannel.messages.fetch(linkedMessageId).catch(() => null);
      if (linked) {
        const linkedRoot = await resolveRoot(linkChannel, linked.id);
        if (linkedRoot) {
          const lfetched = await linkChannel.messages.fetch({ limit: THREAD_WINDOW, before: message.id });
          const lall = [...new Map([linkedRoot, ...lfetched.values()].map((m) => [m.id, m])).values()];
          const lmapped = lall.map((m) => ({ id: m.id, referenceMessageId: m.reference?.messageId || null }));
          const lkeep = filterThreadSubtree(lmapped, linkedRoot.id);
          const lkept = lall
            .filter((m) => lkeep.has(m.id) && m.id !== message.id)
            .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
            .map((m) => mapContextMessage(m, currentSandboxName, timeZone))
            .filter((m) => m && m.content.length > 0);
          result = result.concat(lkept);
        }
      }
    }

    // A linked subtree can overlap the active one. Keep each message once and
    // restore chronological order before limiting the combined context.
    return [...new Map(result.map((entry) => [entry.id, entry])).values()]
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .slice(-THREAD_WINDOW);
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
