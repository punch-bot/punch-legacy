// One full chat turn: sandbox check, STT, attachments, Pi run, output settling,
// memory capture, question/embed extraction, lifecycle reacts, pigeon notify.

import * as store from "../memory.js";
import * as sandbox from "../sandbox-manager.js";
import * as statistics from "../statistics.js";
import * as state from "../state.js";
import {
  getFile,
  apiUrlFor,
  runAgent,
  summarizeSession,
} from "../agent.js";
import {
  isVoiceMessage,
  transcribeVoiceMessage,
  resolveSttConfigForUser,
  discardThinkingMessage,
  mergeTranscriptIntoText,
  STT_USER_ERROR_GENERIC,
} from "../stt.js";
import {
  timestampLine,
  thisTurnInstructions,
  channelContextBlock,
  memoryBlock,
  assemblePrompt,
  userTurnLine,
} from "../prompt-blocks.js";
import { pigeonTurnPreamble, scanOutbound } from "../pigeon-supervisor.js";
import { formatMessageTimestamp } from "../timezone.js";
import { notifyPigeonDone } from "../pigeon-done.js";
import { extractCompressTag } from "../compress-tag.mjs";
import { ensureUserSandbox } from "../core/supervisor.js";
import {
  contextUsageNote,
  applyReactTags,
  extractReactTags,
  reply,
  chunk,
} from "../core/discord.js";
import { registry } from "../core/registry.js";
import { MAX_ATTACHMENT_BYTES } from "../core/config.js";
import {
  createProgressState,
  createProgressRenderer,
  reduceProgressEvent,
  renderProgressLive,
} from "../progress-ui.js";
import {
  downloadMessageAttachments,
  uploadToSandbox,
  pushFile,
  oversizeNote,
  settle,
  extractAttachments,
} from "./attachments.js";
import { persistMemoryTags } from "./memory-tags.js";
import { extractEmbeds, extractQuestions, sendQuestion } from "./embeds-questions.js";
import { formatReplyNewlines } from "../reply-format.js";
import { progressSettingsFor } from "./context.js";
import { labelLineFor, withUserRunLock } from "./queue.js";
import { beginMemoryRecall, endMemoryRecall } from "../memory-recall.js";
import { notifyPigeonDM } from "../gateway/pigeon.js";

async function handleChat(message, text, contextMessages = [], existingThinking = null, signal = null, opts = {}) {
  const uid = opts.userId ?? message.author.id;
  const turn = { startedAt: Date.now(), phase: "starting", detail: "checking sandbox", channelId: message.channelId, steeredTexts: [] };
  registry.activeTurns.set(uid, turn);

  // Ensure this user has their own sandbox workspace
  const sandboxUrl = await ensureUserSandbox(uid);
  if (!sandboxUrl) {
    const mapped = !!apiUrlFor(uid);
    const msg = mapped
      ? "Your sandbox is unreachable. It might be restarting — try again in a few seconds."
      : "You don't have a sandbox yet. Ask an admin to set one up with `/sandbox create <name>` and `/sandbox map @you <name>`.";
    if (existingThinking) {
      await existingThinking.edit({ content: msg, allowedMentions: { parse: [] } }).catch(() => {});
    } else {
      await reply(message, msg);
    }
    registry.activeTurns.delete(uid);
    return;
  }

  // Discord voice memos → transcript, then treat as normal chat text.
  if (isVoiceMessage(message)) {
    turn.phase = "transcribing";
    turn.detail = "transcribing voice memo";
    if (existingThinking) {
      await existingThinking.edit({
        content: "🎧 Transcribing voice memo…",
        allowedMentions: { parse: [] },
      }).catch(() => {});
    }
    const stt = await transcribeVoiceMessage(message, {
      resolveConfig: () => resolveSttConfigForUser(uid),
      signal,
    });
    if (stt.aborted || signal?.aborted) {
      await discardThinkingMessage(existingThinking);
      registry.activeTurns.delete(uid);
      return;
    }
    if (!stt.ok) {
      if (stt.error) console.error(`[stt] uid=${uid} ${stt.error}`);
      const errMsg = stt.userError || STT_USER_ERROR_GENERIC;
      if (existingThinking) {
        await existingThinking.edit({ content: errMsg, allowedMentions: { parse: [] } }).catch(() => {});
      } else {
        await reply(message, errMsg);
      }
      registry.activeTurns.delete(uid);
      return;
    }
    if (stt.text) {
      text = mergeTranscriptIntoText(text, stt.text);
      console.log(`[stt] uid=${uid} transcribed ${stt.text.length} chars`);
    }
  }

  const cid = message.channelId;
  const memoryUserText = text;

  // Gather message attachments (triggering message + any replied-to message)
  // and prepare attachments so the model can read them in the sandbox.
  const skippedAttach = [];
  let agentAttachments = await downloadMessageAttachments(message);
  skippedAttach.push(...agentAttachments.skipped);
  agentAttachments = agentAttachments.attachments;
  if (message.reference?.messageId) {
    try {
      const refMsg = await message.channel.messages.fetch(message.reference.messageId);
      if (refMsg) {
        const r = await downloadMessageAttachments(refMsg);
        agentAttachments = agentAttachments.concat(r.attachments);
        skippedAttach.push(...r.skipped);
      }
    } catch (err) {
      console.error("[attachments] failed to fetch replied message attachments:", err.message);
    }
  }

  // Persist each attachment into the sandbox workspace so the model can read it
  // with its file tools (text for docs/SVG, vision for images). Inline `file`
  // inline file parts are rejected by the gateway, so we save to disk and reference the path.
  const workspaceFiles = [];
  for (const att of agentAttachments) {
    if (!att.data) continue;
    const wp = await uploadToSandbox(uid, att.filename || "file", Buffer.from(att.data, "base64")).catch(() => null);
    if (wp) workspaceFiles.push({ name: att.filename || "file", path: wp });
  }

  if (agentAttachments.length) {
    const names = agentAttachments.map((a) => a.filename).filter(Boolean).join(", ");
    text += `\n\n[Attached ${agentAttachments.length} file(s) for you to read/parse: ${names}]`;
  }
  if (workspaceFiles.length) {
    const list = workspaceFiles.map((f) => `- ${f.name} -> ${f.path}`).join("\n");
    text +=
      `\n\n[The attached file(s) above were saved into your sandbox workspace. ` +
      `Read them with your file-reading tools to parse/inspect them:\n${list}]`;
  }

  if (!text.trim() && agentAttachments.length === 0) {
    if (existingThinking) {
      await existingThinking.edit({
        content: "Say something after the mention (or send a voice memo).",
        allowedMentions: { parse: [] },
      }).catch(() => {});
    } else {
      await reply(message, "Say something after the mention (or send a voice memo).");
    }
    registry.activeTurns.delete(uid);
    return;
  }

  const who = opts.displayName ?? (message.member?.displayName || message.author.username);
  const speakerName = opts.speakerUsername ?? message.author.username;
  const speaker = `${who} (@${speakerName}, id:${uid})`;
  const isDirectMessage = !message.guildId;

  const { useThinking } = progressSettingsFor(message);

  const preambleParts = [];
  const sentAt = formatMessageTimestamp(message.createdTimestamp, store.getUserSettings(uid).timeZone);
  if (sentAt) {
    preambleParts.push(timestampLine(sentAt));
  }
  preambleParts.push(thisTurnInstructions());
  if (opts.reactedTo) preambleParts.push(opts.reactedTo);
  if (opts.repliedTo) preambleParts.push(opts.repliedTo);
  if (opts.pigeonFrom) {
    const sbName = opts.sandboxName || sandbox.loadUsers().find((u) => u.userId === uid)?.name;
    preambleParts.push(pigeonTurnPreamble(opts.pigeonFrom, opts.pigeonHop ?? 0, sbName));
  }
  // The focused reply block already carries the full referenced message.
  // Omit that same message from ambient context so it is not repeated.
  const ambientContext = opts.repliedTo && message.reference?.messageId
    ? contextMessages.filter((ctx) => ctx.id !== message.reference.messageId)
    : contextMessages;
  if (ambientContext.length > 0) preambleParts.push(channelContextBlock(ambientContext));

  let thinking = existingThinking;
  const allowThinking = useThinking && !store.getUserSettings(uid).noThinking;
  const startedAt = Date.now();
  let progressState = createProgressState(startedAt);
  let progressRenderer = null;
  let memoryRecallKey = null;

  if (allowThinking) {
    const initial = renderProgressLive(progressState, startedAt);
    if (thinking) {
      await thinking.edit({ content: initial, allowedMentions: { parse: [] } }).catch(() => {});
    } else {
      thinking = await message
        .reply({
          content: initial,
          allowedMentions: { parse: [], repliedUser: false },
        })
        .catch(() => null);
    }
    if (thinking) {
      progressRenderer = createProgressRenderer({
        initialState: progressState,
        edit: (options) => thinking.edit(options),
        finalSuffix: labelLineFor(uid),
      });
    }
  } else if (thinking) {
    await thinking.delete().catch(() => {});
    thinking = null;
  }

  message.channel.sendTyping().catch(() => {});
  const typing = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);

  const onProgress = (ev) => {
    progressState = progressRenderer
      ? progressRenderer.update(ev)
      : reduceProgressEvent(progressState, ev, Date.now());
    turn.phase = progressState.phase;
    turn.detail = progressState.current;
  };

  const finalizeProgress = async (activity, fallbackStatus, result = "", rich = {}) => {
    if (progressRenderer) {
      await progressRenderer.finalize(activity, fallbackStatus, result, rich);
      progressState = progressRenderer.getState();
    } else if (thinking) {
      await thinking.delete().catch(() => {});
      thinking = null;
    }
  };

  try {
    turn.phase = "thinking";
    turn.detail = "waiting for Pi";
    let compressed = false;
    const res = await withUserRunLock(uid, async () => {
      const currentSession = store.getSession(cid);
      memoryRecallKey = beginMemoryRecall(uid, cid, isDirectMessage);
      const profile = store.coreProfile(uid);
      const memory = memoryBlock({ contextId: memoryRecallKey, profile, unavailable: !store.getMemoryStatus().available });
      if (memory) preambleParts.push(memory);
      const prompt = assemblePrompt(
        preambleParts,
        userTurnLine(uid, speaker, text, { channelId: cid, timeZone: store.getUserSettings(uid).timeZone }),
      );
      console.log(`[chat] uid=${uid} cid=${cid} session=${currentSession || "new"} -> pi`);
      let result;
      try {
        // Only while this chat holds the lock and runs Pi is the gateway's
        // active session this chat's rather than a routine's or heartbeat's,
        // so only then may messages steer it.
        turn.steerable = true;
        result = await runAgent(prompt, currentSession, onProgress, signal, uid, agentAttachments, (sid) => {
          turn.sessionId = sid;
        });
      } finally {
        turn.steerable = false;
      }
      store.setSession(cid, result.sessionId);
      if (result.sessionId && /<\/?compress\s*\/?\s*>/i.test(result.text)) {
        try {
          await summarizeSession(result.sessionId, uid, signal);
          store.clearMemoryRecall(result.sessionId);
          compressed = true;
        } catch (error) {
          console.error(`[compress] model-requested failed:`, error.message);
        }
      }
      return result;
    });
    console.log(`[chat] uid=${uid} cid=${cid} reply len=${res.text.length}`);

    const filesToSend = [];

    const { clean: textAfterMemory, saved, dropped, failed } = persistMemoryTags(res.text, uid, cid);
    const { clean: textAfterAttachments, attachments } = extractAttachments(textAfterMemory);
    const { clean: textAfterReacts, emojis: reactEmojis } = extractReactTags(textAfterAttachments);
    const { clean: textAfterCompress, requested: compressRequested } = extractCompressTag(textAfterReacts);

    for (const relPath of attachments) {
      try {
        const f = await getFile(relPath, uid);
        pushFile(filesToSend, f.buffer, f.name);
      } catch (err) {
        console.error(`[attachments] fetch "${relPath}" failed:`, err.message);
      }
    }

    if (reactEmojis.length) {
      await applyReactTags(message, reactEmojis);
    }

    let out = textAfterCompress || "";
    if (out === "(no output)") out = "";
    if (opts.pigeonFrom) {
      out = scanOutbound(out).text;
    }

    const { clean: textAfterEmbeds, embeds, errors: embedErrors } = extractEmbeds(out);
    const { clean: textAfterQuestions, questions } = extractQuestions(textAfterEmbeds);
    out = formatReplyNewlines(textAfterQuestions || "");

    let capturedMemory = { notesAdded: 0, factsAdded: 0, facts: [] };
    if (isDirectMessage && !message.author.bot && !opts.pigeonFrom) {
      try {
        capturedMemory = store.captureConversation({
          userId: uid,
          channelId: cid,
          isDm: true,
          userText: [memoryUserText, ...turn.steeredTexts].filter(Boolean).join("\n\n"),
          assistantText: out,
          extractDurableFacts: saved === 0 && failed === 0,
        });
      } catch (error) {
        console.error(`[memory] capture failed uid=${uid}:`, error.message);
      }
    }

    const notes = [];
    if (saved) notes.push(`remembered ${saved}`);
    if (capturedMemory.factsAdded) notes.push(`auto-remembered ${capturedMemory.factsAdded}`);
    if (dropped) notes.push(`forgot ${dropped}`);
    if (failed) notes.push(`memory update failed (${failed})`);
    const ctxNote = contextUsageNote(res.usage, uid);
    if (ctxNote) notes.push(ctxNote);
    if (compressed) notes.push("context compressed");
    if (agentAttachments.length) notes.push(`parsed ${agentAttachments.length} attachment(s)`);
    if (skippedAttach.length) notes.push(`skipped ${skippedAttach.length} file(s) over ${Math.round(MAX_ATTACHMENT_BYTES / 1048576)}MB`);
    if (oversizeNote(filesToSend)) notes.push(oversizeNote(filesToSend));
    if (embedErrors.length) notes.push(embedErrors.join("; "));
    if (notes.length) out += (out ? "\n\n" : "") + `_🧠 ${notes.join(", ")}_`;

    const sendable = filesToSend.filter((f) => !f.oversize);
    if (sendable.length > 1) console.log(`[attach-debug] WARNING: ${sendable.length} files in sendable: ${sendable.map((f) => `${f.name}(${f.attachment?.length})`).join(", ")}`);
    const hasText = Boolean(out.trim());
    const hasNotes = notes.length > 0;
    const reactionOnly =
      !hasText && !hasNotes && sendable.length === 0 &&
      reactEmojis.length > 0 && embeds.length === 0 && questions.length === 0;

    const label = labelLineFor(uid);
    const activityStatus = res.activity?.status || "completed";

    const hasResult = out.trim() || sendable.length > 0 || embeds.length > 0 || questions.length > 0;
    if (hasResult) {
      if (progressRenderer) {
        // Keep the answer and activity count in the original status message.
        // Discord's content limit still requires overflow replies for long answers.
        const [primary = "", ...overflow] = chunk(out, 1_650);
        await finalizeProgress(res.activity, activityStatus, primary, { files: sendable, embeds });
        if (overflow.length) await settle(message, overflow.join("") + label);
      } else {
        await settle(message, out + label, sendable, { embeds });
      }
      for (const q of questions) {
        await sendQuestion(message.channel, q, uid);
      }
    }
    if (!hasResult || !progressRenderer) {
      await finalizeProgress(res.activity, activityStatus);
    }

    state.recordActivity({
      userId: uid, channelId: cid, type: "reactive",
      messages: 1 + turn.steeredTexts.length,
      prompt: text.slice(0, 500),
      response: (out || "").slice(0, 2000),
      sessionId: res.sessionId,
      status: activityStatus === "completed" ? "success" : "error",
      duration: Date.now() - startedAt,
      ...statistics.tokenFieldsFromAgent(res),
    });

    if (opts.pigeonFrom) {
      await notifyPigeonDone({
        recipientUserId: uid,
        pigeonFrom: opts.pigeonFrom,
        pigeonHop: opts.pigeonHop ?? 0,
        sandboxName: opts.sandboxName || sandbox.loadUsers().find((u) => u.userId === uid)?.name,
        status: activityStatus === "completed" ? "done" : "failed",
        summary: out,
        error: activityStatus === "completed" ? "" : out,
        notifyPigeonDM,
      });
    }
  } catch (err) {
    console.error(`[chat] cid=${cid} ERROR:`, err?.stack || err?.message || err);
    const aborted = err.name === "AbortError" || /aborted|cancel/i.test(err.message);
    const timedOut = /timed out|timeout|stalled|ceiling|silent for|turn hung/i.test(err?.message || "");
    await finalizeProgress(null, aborted ? "aborted" : timedOut ? "timeout" : "error");
    if (aborted) {
      if (useThinking) {
        await settle(message, "❌ Request cancelled.").catch(() => {});
      }
      if (opts.pigeonFrom) {
        await notifyPigeonDone({
          recipientUserId: uid,
          pigeonFrom: opts.pigeonFrom,
          pigeonHop: opts.pigeonHop ?? 0,
          sandboxName: opts.sandboxName || sandbox.loadUsers().find((u) => u.userId === uid)?.name,
          status: "cancelled",
          notifyPigeonDM,
        });
      }
      state.recordActivity({
        userId: uid,
        channelId: cid,
        type: "reactive",
      messages: 1 + turn.steeredTexts.length,
        prompt: text.slice(0, 500),
        response: String(err?.message || err).slice(0, 2000),
        sessionId: store.getSession(cid),
        status: "cancelled",
        duration: Date.now() - startedAt,
      });
      return;
    }
    let note = "";
    if (timedOut) {
      store.clearSession(cid);
      note = " (hung turn aborted + Pi restart requested — try again)";
    }
    // A previous session stored inline `file` parts (zip/jpg/etc.) that the
    // model now rejects. Clear the poisoned session so the next turn starts
    // fresh — we no longer send file parts (files live in /work/attachments).
    if (/file part media type|functionality not supported/i.test(err?.message || "")) {
      store.clearSession(cid);
      note = " (cleared a session with unsupported file parts — try again)";
    }
    if (useThinking) {
      await settle(message, `⚠️ ${err.message}${note}`).catch((e2) =>
        console.error(`[chat] cid=${cid} reply also failed:`, e2?.message || e2));
    }

    if (opts.pigeonFrom) {
      await notifyPigeonDone({
        recipientUserId: uid,
        pigeonFrom: opts.pigeonFrom,
        pigeonHop: opts.pigeonHop ?? 0,
        sandboxName: opts.sandboxName || sandbox.loadUsers().find((u) => u.userId === uid)?.name,
        status: "failed",
        error: `${err.message}${note}`,
        notifyPigeonDM,
      });
    }
    state.recordActivity({
      userId: uid,
      channelId: cid,
      type: "reactive",
      messages: 1 + turn.steeredTexts.length,
      prompt: text.slice(0, 500),
      response: String(err?.message || err).slice(0, 2000),
      sessionId: store.getSession(cid),
      status: "error",
      duration: Date.now() - startedAt,
    });
  } finally {
    endMemoryRecall(memoryRecallKey);
    registry.activeTurns.delete(uid);
    clearInterval(typing);
  }
}

export { handleChat };
