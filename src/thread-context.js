// Pure helpers for thread-scoped context isolation. No Discord imports so they
// can be unit-tested without booting the client.

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
