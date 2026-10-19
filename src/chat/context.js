import * as store from "../memory.js";
import { sandboxNameForUser } from "../agent.js";
import { fetchChannelContext, mapContextMessage } from "../channel-context.js";
import { THREAD_WINDOW, RESIDUE_LIMIT } from "../core/config.js";
import { PREFIX } from "../core/config.js";
import { registry } from "../core/registry.js";
import { setSecret, getSecrets } from "../agent.js";

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

    if (root.id === message.id && result.length === 0) {
      const residue = await fetchChannelContext(channel, message, {
        currentSandboxName, userId: opts.userId, timeZone, limit: RESIDUE_LIMIT,
      });
      result = result.concat(residue);
    }

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

    return [...new Map(result.map((entry) => [entry.id, entry])).values()]
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .slice(-THREAD_WINDOW);
  } catch (err) {
    console.error("[context] thread fetch failed:", err.message);
    return [];
  }
}

export function progressSettingsFor(message) {
  return { useThinking: true };
}

export const settingsDeps = () => ({
  prefix: PREFIX,
  botUsername: registry.client?.user?.username || "Punch",
  setSecret,
  getSecrets,
});
