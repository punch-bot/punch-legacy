/**
 * Speech-to-text for Discord voice memos.
 *
 * Voice memos are transcribed (OpenAI-compatible /audio/transcriptions) and
 * the transcript is treated as the user's chat text.
 */

const IS_VOICE_MESSAGE = 1 << 13; // discord.js MessageFlags.IsVoiceMessage
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_OPENAI_MODEL = "whisper-1";
/** Groq free-tier Whisper; OpenAI-compatible /audio/transcriptions. */
const DEFAULT_GROQ_MODEL = "whisper-large-v3-turbo";
const DEFAULT_BASE_URL = DEFAULT_OPENAI_BASE_URL;
const DEFAULT_MODEL = DEFAULT_OPENAI_MODEL;
const MAX_VOICE_BYTES = (Number(process.env.STT_MAX_BYTES) || 25) * 1024 * 1024;

function flagHas(message, bit) {
  const flags = message?.flags;
  if (!flags) return false;
  if (typeof flags.has === "function") {
    try {
      return !!flags.has(bit);
    } catch {
      /* fall through */
    }
  }
  const bits = Number(flags.bitfield ?? flags);
  return Number.isFinite(bits) && (bits & bit) === bit;
}

function isAudioAttachment(att) {
  const mime = String(att?.contentType || "").toLowerCase();
  if (mime.startsWith("audio/")) return true;
  const name = String(att?.name || "").toLowerCase();
  return /\.(ogg|opus|mp3|wav|m4a|webm|flac)$/.test(name);
}

/** True when this Discord message is (or contains) a voice memo. */
export function isVoiceMessage(message) {
  if (flagHas(message, IS_VOICE_MESSAGE)) return true;
  return findVoiceAttachments(message).length > 0;
}

/**
 * Voice-memo attachments on a message.
 * Prefers Discord voice-message metadata (waveform/duration); if the message
 * has the IsVoiceMessage flag, any audio attachment counts.
 */
export function findVoiceAttachments(message) {
  const items = message?.attachments ? [...message.attachments.values()] : [];
  const flagged = flagHas(message, IS_VOICE_MESSAGE);
  return items.filter((att) => {
    // Discord voice memos always carry duration/waveform metadata.
    if (att?.waveform != null || att?.duration != null) return true;
    if (flagged && isAudioAttachment(att)) return true;
    return false;
  });
}

export function mergeTranscriptIntoText(existingText, transcript) {
  const text = String(existingText || "").trim();
  const spoken = String(transcript || "").trim();
  if (!spoken) return text;
  if (!text) return spoken;
  return `${spoken}\n\n${text}`;
}

/**
 * Resolve OpenAI-compatible STT settings (`/audio/transcriptions`).
 *
 * Credential priority (bot env, then sandbox env):
 *   STT_API_KEY → GROQ_API_KEY → OPENAI_API_KEY
 *
 * `GROQ_API_KEY` is the recommended free path (Groq Whisper free tier).
 * Endpoint (`STT_BASE_URL`) is always operator-controlled (bot env only) so
 * sandboxes cannot redirect bot-side HTTP (SSRF / key exfil).
 */
export function resolveSttConfig({ env = process.env, sandboxEnv = {} } = {}) {
  const botRaw = pickSttCredential(env);
  const sandboxRaw = pickSttCredential(sandboxEnv);
  const cred = botRaw
    ? { ...botRaw, source: "bot" }
    : sandboxRaw
      ? { ...sandboxRaw, source: "sandbox" }
      : null;
  const operatorBase = env.STT_BASE_URL
    ? String(env.STT_BASE_URL).replace(/\/$/, "")
    : null;

  if (!cred) {
    return {
      apiKey: null,
      baseUrl: operatorBase || DEFAULT_BASE_URL,
      model: env.STT_MODEL || DEFAULT_MODEL,
      provider: null,
    };
  }

  const defaults = defaultsForProvider(cred.provider);
  const modelOverride =
    cred.source === "bot"
      ? env.STT_MODEL
      : sandboxEnv.STT_MODEL || env.STT_MODEL;

  return {
    apiKey: cred.apiKey,
    baseUrl: operatorBase || defaults.baseUrl,
    model: modelOverride || defaults.model,
    provider: cred.provider,
  };
}

function pickSttCredential(bag) {
  if (!bag || typeof bag !== "object") return null;
  if (bag.STT_API_KEY) return { apiKey: bag.STT_API_KEY, provider: "stt" };
  if (bag.GROQ_API_KEY) return { apiKey: bag.GROQ_API_KEY, provider: "groq" };
  if (bag.OPENAI_API_KEY) return { apiKey: bag.OPENAI_API_KEY, provider: "openai" };
  return null;
}

function defaultsForProvider(provider) {
  if (provider === "groq") {
    return { baseUrl: DEFAULT_GROQ_BASE_URL, model: DEFAULT_GROQ_MODEL };
  }
  return { baseUrl: DEFAULT_OPENAI_BASE_URL, model: DEFAULT_OPENAI_MODEL };
}

export async function transcribeAudioBuffer({
  buffer,
  filename = "voice-message.ogg",
  mime = "audio/ogg",
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  model = DEFAULT_MODEL,
  fetchImpl = fetch,
  timeoutMs = 60_000,
} = {}) {
  if (!apiKey) throw new Error("Missing STT API key");
  if (!buffer?.length) throw new Error("Empty audio buffer");
  if (buffer.length > MAX_VOICE_BYTES) {
    throw new Error(`Voice memo exceeds ${Math.round(MAX_VOICE_BYTES / 1048576)}MB STT limit`);
  }

  const form = new FormData();
  const bytes = buffer instanceof Uint8Array ? buffer : Buffer.from(buffer);
  const blob = new Blob([bytes], { type: mime || "audio/ogg" });
  const safeName = String(filename || "voice-message.ogg").replace(/[^\w.\-]+/g, "_") || "voice-message.ogg";
  form.append("file", blob, safeName.includes(".") ? safeName : `${safeName}.ogg`);
  form.append("model", model);

  const url = `${String(baseUrl).replace(/\/$/, "")}/audio/transcriptions`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`STT API ${res.status}: ${detail.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = typeof data?.text === "string" ? data.text.trim() : "";
  if (!text) throw new Error("STT returned empty transcript");
  return text;
}

/**
 * Transcribe the first voice memo on a Discord message.
 * @returns {{ ok: boolean, skipped?: boolean, text?: string|null, error?: string }}
 */
export async function transcribeVoiceMessage(message, {
  resolveConfig,
  fetchImpl = fetch,
  maxBytes = MAX_VOICE_BYTES,
} = {}) {
  const voices = findVoiceAttachments(message);
  if (!voices.length) {
    return { ok: true, skipped: true, text: null };
  }

  const cfg = await resolveConfig();
  if (!cfg?.apiKey) {
    return {
      ok: false,
      text: null,
      error:
        "Voice memos need an STT API key. Free option: set `GROQ_API_KEY` on the bot " +
        "(or `/apikey set groq <key>`). Paid: `STT_API_KEY` / `OPENAI_API_KEY`.",
    };
  }

  const att = voices[0];
  if (att.size > maxBytes) {
    return {
      ok: false,
      text: null,
      error: `Voice memo is too large (max ${Math.round(maxBytes / 1048576)}MB).`,
    };
  }

  try {
    const dl = await fetchImpl(att.url, { signal: AbortSignal.timeout(30_000) });
    if (!dl.ok) {
      return { ok: false, text: null, error: `Failed to download voice memo (${dl.status}).` };
    }
    const buffer = Buffer.from(await dl.arrayBuffer());
    const text = await transcribeAudioBuffer({
      buffer,
      filename: att.name || "voice-message.ogg",
      mime: att.contentType || "audio/ogg",
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      fetchImpl,
    });
    return { ok: true, skipped: false, text };
  } catch (err) {
    console.error("[stt] transcription failed:", err.message);
    return { ok: false, text: null, error: `Could not transcribe voice memo: ${err.message}` };
  }
}
