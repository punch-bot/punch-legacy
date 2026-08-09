// Centralized builders for every section of the assembled user-turn prompt.
// Every delimited block uses a consistent `--- {name} ---` / `--- End {footer} ---` pair.

export function promptBlock(name, body, footer = name) {
  const text = String(body ?? "").trim();
  if (!text) return "";
  return `--- ${name} ---\n${text}\n--- End ${footer} ---`;
}

// Channel context from recent messages. `contextMessages` is an array of
// `{ author, content }` objects (never empty when called).
export function channelContextBlock(contextMessages) {
  return promptBlock(
    "Channel context (background only)",
    contextMessages.map((ctx) => `[${ctx.author}] ${ctx.content}`).join("\n"),
    "channel context",
  );
}

export function thisTurnInstructions() {
  return (
    "--- This turn ---\n" +
    "The message below triggered this turn. To react on it, append " +
    '<react emoji="..."></react> to your reply — Punch applies reactions automatically. ' +
    "Do not use Discord API, curl, or ask for channel/message IDs."
  );
}

export function reactedToBlock(authorName, content) {
  return promptBlock("Reacted-to message", `[${authorName}]: ${content}`, "reacted-to message");
}

export function repliedToBlock(authorName, content) {
  return promptBlock("Replied-to message", `[${authorName}]: ${content}`, "replied-to message");
}

export function pigeonSupervisorBlock(body) {
  return promptBlock("PIGEON SUPERVISOR", body);
}

// Unified memory section: durable project memory (.punch-memory.md) plus
// auto-retrieved related memory. Returns "" when there is nothing to inject.
export function memoryBlock({ projectMemory = "", relatedText = "" } = {}) {
  const parts = [];
  if (projectMemory) {
    parts.push(
      "Project memory (update /work/.punch-memory.md when needed):\n" +
        projectMemory.trim(),
    );
  }
  if (relatedText) {
    parts.push(
      "Related memory (auto-retrieved — may be stale; verify before relying):\n" +
        relatedText.trim(),
    );
  }
  return promptBlock("Punch memory", parts.join("\n\n"));
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

export function userTurnLine(uid, speaker, text) {
  return `[user:${uid}] ${speaker}: ${text}`;
}

export function assemblePrompt(parts, userLine) {
  const preamble = parts.filter(Boolean).join("\n\n");
  return preamble ? `${preamble}\n\n${userLine}` : userLine;
}
