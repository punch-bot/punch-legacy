// @ts-nocheck
/**
 * Shared Punch agent turn helper for non-Discord entrypoints (Spectrum).
 * Keeps Discord handleChat intact; this is the minimal assemble → runAgent path.
 * Punch core (agent/memory) is plain JS without complete JSDoc; skip checkJs here.
 */

import {
  runAgent,
  getFile,
  reloadSandboxMap,
  apiUrlFor,
} from "./agent.js";
import * as store from "./memory.js";
import {
  assemblePrompt,
  userTurnLine,
  memoryBlock,
  promptBlock,
} from "./prompt-blocks.js";
import { formatMessageTimestamp } from "./timezone.js";

const NO_SANDBOX_MSG =
  "You don't have a Punch sandbox yet. Ask an admin to set one up with `/sandbox create <name>` " +
  "and map your Discord user ID, then set SPECTRUM_DEFAULT_USER_ID (or SPECTRUM_USER_MAP) to that user ID.";

const DISCORD_TAG_RE =
  /<(?:react|remember|forget|embed|question)\b[^>]*>[\s\S]*?<\/(?:react|remember|forget|embed|question)>/gi;
const DISCORD_SELF_CLOSING_RE =
  /<(?:react|forget)\b[^>]*\/?>/gi;

/**
 * Strip Discord-oriented markup Punch models sometimes emit.
 * @param {string} text
 */
export function stripDiscordMarkup(text) {
  return String(text || "")
    .replace(DISCORD_TAG_RE, "")
    .replace(DISCORD_SELF_CLOSING_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function spectrumTurnInstructions() {
  return promptBlock(
    "This turn",
    "The message below arrived via Spectrum (iMessage/terminal). Reply in plain text suitable for that channel. " +
      "Do not emit Discord-only tags (<react>, <embed>, <question>).",
    "this turn",
  );
}

async function fetchProjectMemory(uid) {
  try {
    const file = await getFile("/work/.punch-memory.md", uid);
    const text = file.buffer.toString("utf8").trim().slice(0, 12_000);
    return text || "";
  } catch {
    return "";
  }
}

/**
 * @param {{
 *   userId: string,
 *   sessionKey: string,
 *   text: string,
 *   speaker?: string,
 *   signal?: AbortSignal | null,
 *   onProgress?: ((ev: unknown) => void) | null,
 * }} args
 * @returns {Promise<{ ok: true, text: string, sessionId: string | null, usage?: unknown } | { ok: false, error: string, code: string }>}
 */
export async function runPunchTurn({
  userId,
  sessionKey,
  text,
  speaker = null,
  signal = null,
  onProgress = null,
}) {
  const uid = String(userId || "").trim();
  const key = String(sessionKey || "").trim();
  const body = String(text || "").trim();
  if (!uid) {
    return { ok: false, code: "missing_user", error: "Punch userId is required." };
  }
  if (!key) {
    return { ok: false, code: "missing_session_key", error: "sessionKey is required." };
  }
  if (!body) {
    return { ok: false, code: "empty_text", error: "Message text is empty." };
  }

  reloadSandboxMap();
  if (!apiUrlFor(uid)) {
    return { ok: false, code: "no_sandbox", error: NO_SANDBOX_MSG };
  }

  const projectMemory = await fetchProjectMemory(uid);
  const relatedText = store.preamble(uid, key, body, { isDm: true });
  const settings = store.getUserSettings(uid);
  const sentAt = formatMessageTimestamp(Date.now(), settings.timeZone);
  const who = speaker || `spectrum-user`;
  const speakerLabel = `${who} (id:${uid})`;

  const preambleParts = [];
  if (sentAt) preambleParts.push(`Message sent at ${sentAt}.`);
  preambleParts.push(spectrumTurnInstructions());
  preambleParts.push(memoryBlock({ projectMemory, relatedText }));

  const prompt = assemblePrompt(
    preambleParts,
    userTurnLine(uid, speakerLabel, body, {
      channelId: key,
      timeZone: settings.timeZone,
    }),
  );

  const currentSession = store.getSession(key);
  let result;
  try {
    result = await runAgent(prompt, currentSession, onProgress, signal, uid, []);
  } catch (err) {
    const message = err && typeof err === "object" && "message" in err
      ? String(/** @type {{ message: unknown }} */ (err).message)
      : String(err);
    return { ok: false, code: "agent_error", error: message };
  }

  if (result?.sessionId) {
    store.setSession(key, result.sessionId);
  }

  const replyText = stripDiscordMarkup(result?.text || "");
  store.captureConversation({
    userId: uid,
    channelId: key,
    isDm: true,
    userText: body,
    assistantText: replyText,
  });

  return {
    ok: true,
    text: replyText || "(no response)",
    sessionId: result?.sessionId || null,
    usage: result?.usage,
  };
}

export { NO_SANDBOX_MSG };
