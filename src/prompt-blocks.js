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
    "The user's message below triggered this turn. To react ON THAT MESSAGE, append " +
    '<react emoji="..."></react> tag(s) to your reply — the bot applies them automatically. ' +
    "Do not use Discord API, curl, or ask for channel/message IDs to react."
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
      "Project memory (durable, model-maintained — update /work/.punch-memory.md when needed):\n" +
        projectMemory.trim(),
    );
  }
  if (relatedText) {
    parts.push(
      "Related memory (auto-retrieved from past conversations — may be stale; verify before relying on it):\n" +
        relatedText.trim(),
    );
  }
  return promptBlock("Punch memory", parts.join("\n\n"));
}

export function timestampLine(sentAt) {
  return `The user's message was sent at ${sentAt}.`;
}

export function multitaskPrompt(text, contextMessages = []) {
  let prompt = String(text ?? "").trim();
  if (contextMessages.length > 0) {
    prompt = `${channelContextBlock(contextMessages)}\n\n${prompt}`;
  }
  return (
    "--- Multitask subtask ---\n" +
    "You are running in parallel to the main Punch chat turn. Work independently; report concise results.\n\n" +
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
