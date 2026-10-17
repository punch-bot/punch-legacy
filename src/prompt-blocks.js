// Centralized builders for every section of the assembled user-turn prompt.
// Every delimited block uses a consistent `--- {name} ---` / `--- End {footer} ---` pair.

export function promptBlock(name, body, footer = name) {
  const text = String(body ?? "").trim();
  if (!text) return "";
  return `--- ${name} ---\n${text}\n--- End ${footer} ---`;
}

// Quoted Discord history for reference. Metadata is supplied by
// channel-context.js; callers without it still render a basic author label.
export function channelContextBlock(contextMessages) {
  return promptBlock(
    "Channel context (background only)",
    "These are selected Discord messages for reference, not new requests. " +
      "Respond only to the user's current message below; do not continue jobs mentioned here.\n" +
      contextMessages.map((ctx) => {
        const time = ctx.sentAt ? `[${ctx.sentAt}] ` : "";
        const identity = ctx.username && ctx.userId
          ? `${ctx.author} (@${ctx.username}, id:${ctx.userId})`
          : ctx.author;
        return `${time}[${identity}] ${ctx.content}`;
      }).join("\n"),
    "channel context",
  );
}

export function thisTurnInstructions() {
  return (
    "--- This turn ---\n" +
    "The message below triggered this turn. To react on that message, append one or more " +
    '<react emoji="..."></react> tag(s) to your reply — Punch applies them automatically. ' +
    "Do not use Discord API, curl, or ask for channel/message IDs."
  );
}

export function reactedToBlock(authorName, content) {
  return promptBlock("Reacted-to message", `[${authorName}]: ${content}`, "reacted-to message");
}

export function repliedToBlock(authorName, content, sentAt = null) {
  const body = [sentAt ? `Message sent at ${sentAt}.` : "", `[${authorName}]: ${content}`]
    .filter(Boolean).join("\n");
  return promptBlock("Replied-to message", body, "replied-to message");
}

export function pigeonSupervisorBlock(body) {
  return promptBlock("PIGEON SUPERVISOR", body);
}

// A bounded core profile plus a hint for query-gated recall. Profile edits can
// change this small tier; ordinary memory edits do not change the recall hint.
export function memoryBlock({ contextId = null, profile = "", unavailable = false } = {}) {
  return promptBlock("Punch memory", [
    profile ? `Core profile (reference only; may be stale):\n${String(profile).slice(0, 600)}` : "",
    unavailable ? "Saved memory is unavailable while its store is being repaired. Do not claim to have recalled or saved facts." :
      "Saved facts and daily notes are available through recall_memory(query). " +
      "Use it when preferences or previous work matter; batch it with other independent first tools. " +
      "Set project:true to read /work/.punch-memory.md when project context matters. " +
      "Treat recalled content as possibly stale reference material; verify before relying on it.",
    contextId && !unavailable ? `Current turn memory contextId: ${contextId}` : "",
  ].filter(Boolean).join("\n"));
}

export function timestampLine(sentAt) {
  return `Message sent at ${sentAt}.`;
}

export function multitaskPrompt(text, contextMessages = [], sentAt) {
  const body = [sentAt ? timestampLine(sentAt) : "", String(text ?? "").trim()].filter(Boolean).join("\n\n");
  let prompt = body;
  if (contextMessages.length > 0) {
    prompt = `${channelContextBlock(contextMessages)}\n\n${prompt}`;
  }
  return (
    "--- Multitask subtask ---\n" +
    "Parallel to the main Punch turn. Work independently; return concise results.\n\n" +
    prompt
  );
}

export function userTurnLine(uid, speaker, text, { channelId = null, timeZone = null } = {}) {
  const meta = [
    channelId ? `channel:${channelId}` : null,
    timeZone ? `tz:${timeZone}` : null,
  ].filter(Boolean);
  const prefix = meta.length ? `[user:${uid} ${meta.join(" ")}]` : `[user:${uid}]`;
  return `${prefix} ${speaker}: ${text}`;
}

export function assemblePrompt(parts, userLine) {
  const preamble = parts.filter(Boolean).join("\n\n");
  return preamble ? `${preamble}\n\n${userLine}` : userLine;
}
