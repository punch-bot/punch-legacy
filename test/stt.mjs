import assert from "node:assert/strict";
import test from "node:test";

import {
  discardThinkingMessage,
  findVoiceAttachments,
  isVoiceMessage,
  mergeTranscriptIntoText,
  resolveSttConfig,
  shouldAcceptChatTurn,
  STT_USER_ERROR_GENERIC,
  STT_USER_ERROR_NO_KEY,
  transcribeAudioBuffer,
  transcribeVoiceMessage,
} from "../src/stt.js";

const VOICE_FLAG = 1 << 13; // MessageFlags.IsVoiceMessage

function mockAttachment(partial = {}) {
  return {
    id: "1",
    name: "voice-message.ogg",
    url: "https://cdn.discordapp.com/attachments/1/voice-message.ogg",
    contentType: "audio/ogg",
    size: 1024,
    duration: 3.5,
    waveform: "AQID",
    ...partial,
  };
}

function mockMessage({ flags = 0, attachments = [] } = {}) {
  const map = new Map(attachments.map((a, i) => [a.id || String(i), a]));
  return {
    flags: {
      bitfield: flags,
      has: (flag) => {
        const bit = typeof flag === "number" ? flag : Number(flag);
        return (flags & bit) === bit;
      },
    },
    attachments: map,
  };
}

test("isVoiceMessage detects MessageFlags.IsVoiceMessage", () => {
  assert.equal(isVoiceMessage(mockMessage({ flags: VOICE_FLAG })), true);
  assert.equal(isVoiceMessage(mockMessage({ flags: 0 })), false);
});

test("isVoiceMessage detects waveform/duration attachments", () => {
  assert.equal(
    isVoiceMessage(mockMessage({ attachments: [mockAttachment()] })),
    true,
  );
  assert.equal(
    isVoiceMessage(
      mockMessage({
        attachments: [mockAttachment({ duration: null, waveform: null, contentType: "image/png", name: "x.png" })],
      }),
    ),
    false,
  );
});

test("findVoiceAttachments returns only voice/audio memo attachments", () => {
  const voice = mockAttachment({ id: "v" });
  const image = mockAttachment({
    id: "i",
    name: "pic.png",
    contentType: "image/png",
    duration: null,
    waveform: null,
  });
  const found = findVoiceAttachments(
    mockMessage({ flags: VOICE_FLAG, attachments: [voice, image] }),
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].id, "v");
});

test("mergeTranscriptIntoText prefers transcript when text is empty", () => {
  assert.equal(mergeTranscriptIntoText("", "hello world"), "hello world");
  assert.equal(mergeTranscriptIntoText("note", "hello"), "hello\n\nnote");
});

test("resolveSttConfig prefers bot STT_API_KEY over sandbox env", () => {
  const cfg = resolveSttConfig({
    env: { STT_API_KEY: "bot-stt", OPENAI_API_KEY: "bot-openai" },
    sandboxEnv: { OPENAI_API_KEY: "user-openai" },
  });
  assert.equal(cfg.apiKey, "bot-stt");
  assert.equal(cfg.baseUrl, "https://api.openai.com/v1");
  assert.equal(cfg.model, "whisper-1");
  assert.equal(cfg.provider, "stt");
});

test("resolveSttConfig uses Groq free-tier defaults for GROQ_API_KEY", () => {
  const cfg = resolveSttConfig({
    env: { GROQ_API_KEY: "gsk-free" },
    sandboxEnv: {},
  });
  assert.equal(cfg.apiKey, "gsk-free");
  assert.equal(cfg.baseUrl, "https://api.groq.com/openai/v1");
  assert.equal(cfg.model, "whisper-large-v3-turbo");
  assert.equal(cfg.provider, "groq");
});

test("resolveSttConfig prefers GROQ_API_KEY over OPENAI_API_KEY", () => {
  const cfg = resolveSttConfig({
    env: { GROQ_API_KEY: "gsk", OPENAI_API_KEY: "sk" },
    sandboxEnv: {},
  });
  assert.equal(cfg.provider, "groq");
  assert.equal(cfg.apiKey, "gsk");
});

test("resolveSttConfig uses sandbox GROQ_API_KEY with Groq endpoint", () => {
  const cfg = resolveSttConfig({
    env: {},
    sandboxEnv: { GROQ_API_KEY: "gsk-user" },
  });
  assert.equal(cfg.apiKey, "gsk-user");
  assert.equal(cfg.baseUrl, "https://api.groq.com/openai/v1");
  assert.equal(cfg.model, "whisper-large-v3-turbo");
});

test("resolveSttConfig ignores sandbox endpoint/model when bot key is used", () => {
  const cfg = resolveSttConfig({
    env: { STT_API_KEY: "bot-stt" },
    sandboxEnv: {
      OPENAI_API_KEY: "user-openai",
      STT_BASE_URL: "https://evil.example/v1",
      STT_MODEL: "exfil-model",
    },
  });
  assert.equal(cfg.apiKey, "bot-stt");
  assert.equal(cfg.baseUrl, "https://api.openai.com/v1");
  assert.equal(cfg.model, "whisper-1");
});

test("resolveSttConfig ignores sandbox STT_BASE_URL even with sandbox-owned key", () => {
  const cfg = resolveSttConfig({
    env: {},
    sandboxEnv: {
      STT_API_KEY: "user-stt",
      STT_BASE_URL: "http://127.0.0.1:9/v1",
      STT_MODEL: "whisper-large-v3",
    },
  });
  assert.equal(cfg.apiKey, "user-stt");
  assert.equal(cfg.baseUrl, "https://api.openai.com/v1");
  assert.equal(cfg.model, "whisper-large-v3");
});

test("resolveSttConfig falls back to sandbox OPENAI_API_KEY", () => {
  const cfg = resolveSttConfig({
    env: {},
    sandboxEnv: { OPENAI_API_KEY: "user-openai", STT_API_KEY: "user-stt" },
  });
  assert.equal(cfg.apiKey, "user-stt");
});

test("resolveSttConfig returns null key when nothing is configured", () => {
  const cfg = resolveSttConfig({ env: {}, sandboxEnv: {} });
  assert.equal(cfg.apiKey, null);
});

test("resolveSttConfig honors bot STT_BASE_URL and STT_MODEL", () => {
  const cfg = resolveSttConfig({
    env: {
      GROQ_API_KEY: "k",
      STT_BASE_URL: "https://api.groq.com/openai/v1/",
      STT_MODEL: "whisper-large-v3",
    },
    sandboxEnv: {
      STT_BASE_URL: "http://169.254.169.254/",
    },
  });
  assert.equal(cfg.baseUrl, "https://api.groq.com/openai/v1");
  assert.equal(cfg.model, "whisper-large-v3");
});

test("transcribeAudioBuffer posts multipart whisper request", async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      status: 200,
      json: async () => ({ text: "  buy milk  " }),
      text: async () => "",
    };
  };

  const text = await transcribeAudioBuffer({
    buffer: Buffer.from("ogg-bytes"),
    filename: "voice-message.ogg",
    mime: "audio/ogg",
    apiKey: "sk-test",
    baseUrl: "https://api.openai.com/v1",
    model: "whisper-1",
    fetchImpl: fakeFetch,
  });

  assert.equal(text, "buy milk");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/audio/transcriptions");
  assert.equal(calls[0].opts.method, "POST");
  assert.equal(calls[0].opts.headers.Authorization, "Bearer sk-test");
  assert.ok(calls[0].opts.body instanceof FormData);
});

test("transcribeAudioBuffer throws on API failure", async () => {
  await assert.rejects(
    () =>
      transcribeAudioBuffer({
        buffer: Buffer.from("x"),
        filename: "voice.ogg",
        apiKey: "sk",
        fetchImpl: async () => ({
          ok: false,
          status: 401,
          text: async () => "unauthorized",
          json: async () => ({}),
        }),
      }),
    /STT API 401/,
  );
});

test("transcribeVoiceMessage downloads and transcribes the first voice attachment", async () => {
  const message = mockMessage({
    flags: VOICE_FLAG,
    attachments: [mockAttachment()],
  });

  const result = await transcribeVoiceMessage(message, {
    resolveConfig: async () => ({
      apiKey: "sk",
      baseUrl: "https://api.openai.com/v1",
      model: "whisper-1",
    }),
    fetchImpl: async (url) => {
      if (String(url).includes("cdn.discordapp.com")) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => Buffer.from("audio").buffer,
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ text: "schedule lunch tomorrow" }),
        text: async () => "",
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.text, "schedule lunch tomorrow");
  assert.equal(result.skipped, false);
});

test("transcribeVoiceMessage skips when message has no voice memo", async () => {
  const result = await transcribeVoiceMessage(mockMessage(), {
    resolveConfig: async () => ({ apiKey: "sk", baseUrl: "https://api.openai.com/v1", model: "whisper-1" }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.text, null);
});

test("transcribeVoiceMessage returns config error when no API key", async () => {
  const message = mockMessage({
    flags: VOICE_FLAG,
    attachments: [mockAttachment()],
  });
  const result = await transcribeVoiceMessage(message, {
    resolveConfig: async () => ({ apiKey: null, baseUrl: "https://api.openai.com/v1", model: "whisper-1" }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /API key/i);
  assert.equal(result.userError, STT_USER_ERROR_NO_KEY);
});

test("transcribeVoiceMessage sanitizes provider failures for users", async () => {
  const message = mockMessage({
    flags: VOICE_FLAG,
    attachments: [mockAttachment()],
  });
  const result = await transcribeVoiceMessage(message, {
    resolveConfig: async () => ({
      apiKey: "sk",
      baseUrl: "https://api.openai.com/v1",
      model: "whisper-1",
    }),
    fetchImpl: async (url) => {
      if (String(url).includes("cdn.discordapp.com")) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => Buffer.from("audio").buffer,
        };
      }
      return {
        ok: false,
        status: 500,
        text: async () => "internal secret details",
        json: async () => ({}),
      };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.userError, STT_USER_ERROR_GENERIC);
  assert.match(result.error, /STT API 500/);
  assert.equal(result.userError.includes("secret"), false);
});

test("transcribeVoiceMessage aborts when signal fires during download", async () => {
  const message = mockMessage({
    flags: VOICE_FLAG,
    attachments: [mockAttachment()],
  });
  const ac = new AbortController();
  const result = await transcribeVoiceMessage(message, {
    signal: ac.signal,
    resolveConfig: async () => ({
      apiKey: "sk",
      baseUrl: "https://api.openai.com/v1",
      model: "whisper-1",
    }),
    fetchImpl: async (_url, opts) => {
      ac.abort();
      const err = new Error("aborted");
      err.name = "AbortError";
      // Mimic fetch rejecting on abort
      if (opts?.signal?.aborted) throw err;
      throw err;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.aborted, true);
  assert.equal(result.userError, null);
});

test("transcribeAudioBuffer passes abort signal to provider fetch", async () => {
  const ac = new AbortController();
  let sawSignal = false;
  await assert.rejects(
    () =>
      transcribeAudioBuffer({
        buffer: Buffer.from("ogg"),
        filename: "voice.ogg",
        apiKey: "sk",
        signal: ac.signal,
        fetchImpl: async (_url, opts) => {
          sawSignal = !!opts.signal;
          ac.abort();
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        },
      }),
    (err) => err.name === "AbortError",
  );
  assert.equal(sawSignal, true);
});

test("shouldAcceptChatTurn allows DM voice without mention", () => {
  assert.equal(
    shouldAcceptChatTurn({ isDM: true, voiceMemo: true }),
    true,
  );
});

test("shouldAcceptChatTurn allows guild voice only when reply-to-bot", () => {
  assert.equal(
    shouldAcceptChatTurn({
      isDM: false,
      mentioned: false,
      voiceMemo: true,
      replyToBot: true,
    }),
    true,
  );
  assert.equal(
    shouldAcceptChatTurn({
      isDM: false,
      mentioned: false,
      voiceMemo: true,
      replyToBot: false,
    }),
    false,
  );
});

test("shouldAcceptChatTurn rejects unrelated guild voice (no STT path)", () => {
  assert.equal(
    shouldAcceptChatTurn({
      isDM: false,
      mentioned: false,
      contentStartsWithPrefix: false,
      voiceMemo: true,
      replyToBot: false,
      summonMatched: false,
    }),
    false,
  );
});

test("mergeTranscriptIntoText merges spoken text once", () => {
  assert.equal(mergeTranscriptIntoText("extra", "hello"), "hello\n\nextra");
  assert.equal(mergeTranscriptIntoText("", "hello"), "hello");
});

test("discardThinkingMessage deletes queued progress messages on cancel", async () => {
  let deleted = 0;
  const msg = {
    delete: async () => {
      deleted += 1;
    },
  };
  assert.equal(await discardThinkingMessage(msg), true);
  assert.equal(deleted, 1);
  assert.equal(await discardThinkingMessage(null), false);
  assert.equal(await discardThinkingMessage({}), false);
});
