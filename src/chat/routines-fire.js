// Routine execution: heartbeat / message / llm automation firing.
// Routines scheduler calls fireRoutine; this module sends results to the user's
// DM or the scheduled channel, persisting memory/attachments/embeds/questions
// from the agent output exactly like a normal chat turn.

import * as store from "../memory.js";
import * as state from "../state.js";
import * as statistics from "../statistics.js";
import { runAgent, getFile } from "../agent.js";
import { registry } from "../core/registry.js";
import { chunk } from "../core/discord.js";
import { ensureUserSandbox } from "../core/supervisor.js";
import { persistMemoryTags } from "../chat/memory-tags.js";
import {
  extractAttachments,
  pushFile,
  oversizeNote,
} from "../chat/attachments.js";
import {
  extractEmbeds,
  extractQuestions,
  sendQuestion,
} from "../chat/embeds-questions.js";
import { withUserRunLock, labelLineFor } from "../chat/queue.js";

async function fireRoutine(routine) {
  // Heartbeat routines DM the user directly — no channel needed
  if (routine.type === "heartbeat") {
    const uid = routine.userId;
    console.log(`[heartbeat] firing routine ${routine.id} uid=${uid}`);
    const start = Date.now();

    const sandboxUrl = await ensureUserSandbox(uid);
    if (!sandboxUrl) {
      try {
        const dm = await registry.client.users.createDM(uid);
        await dm.send("⚠️ Heartbeat failed — sandbox unreachable.");
      } catch {}
      state.recordActivity({
        userId: uid, type: "heartbeat", prompt: routine.payload.slice(0, 500),
        response: "sandbox unreachable", status: "error", duration: Date.now() - start,
        routineId: routine.id,
      });
      throw new Error(`sandbox unreachable for heartbeat ${routine.id}`);
    }

    const existingSession = state.getHeartbeatSession(uid);
    const prompt = `[user:${uid}] (heartbeat): ${routine.payload}`;

    try {
      const res = await withUserRunLock(uid, () =>
        runAgent(prompt, existingSession, null, null, uid),
      );
      state.setHeartbeatSession(uid, res.sessionId);

      const { clean: textAfterMemory, saved, dropped } = persistMemoryTags(res.text, uid, null);
      const { clean: textAfterAttachments, attachments } = extractAttachments(textAfterMemory);

      const filesToSend = [];
      for (const relPath of attachments) {
        try {
          const f = await getFile(relPath, uid);
          pushFile(filesToSend, f.buffer, f.name);
        } catch (err) {
          console.error(`[heartbeat] attachment fetch failed:`, err.message);
        }
      }

      let out = textAfterAttachments || "";
      const { clean: textAfterEmbeds, embeds, errors: embedErrors } = extractEmbeds(out);
      const { clean: textAfterQuestions, questions } = extractQuestions(textAfterEmbeds);
      out = textAfterQuestions || "";

      const notes = [];
      if (saved) notes.push(`remembered ${saved}`);
      if (dropped) notes.push(`forgot ${dropped}`);
      if (oversizeNote(filesToSend)) notes.push(oversizeNote(filesToSend));
      if (embedErrors.length) notes.push(embedErrors.join("; "));
      if (notes.length) out += (out ? "\n\n" : "") + `_🧠 ${notes.join(", ")}_`;

      const sendable = filesToSend.filter((f) => !f.oversize);
      if (!out && sendable.length === 0 && embeds.length === 0 && questions.length === 0) {
        out = "_(heartbeat completed, no output)_";
      }

      const header = `💓 **Heartbeat** —\n`;
      const dm = await registry.client.users.createDM(uid);
      const parts = chunk(header + out);
      for (let i = 0; i < parts.length; i++) {
        const options = { content: parts[i], allowedMentions: { parse: [] } };
        if (i === 0) {
          if (sendable.length > 0) options.files = sendable;
          if (embeds.length > 0) options.embeds = embeds;
        }
        await dm.send(options);
      }
      for (const q of questions) {
        await sendQuestion(dm, q, uid);
      }

      state.recordActivity({
        userId: uid, type: "heartbeat", prompt: routine.payload.slice(0, 500),
        response: (out || "").slice(0, 2000), sessionId: res.sessionId, status: "success",
        duration: Date.now() - start, routineId: routine.id,
        ...statistics.tokenFieldsFromAgent(res),
      });
    } catch (err) {
      console.error(`[heartbeat] routine ${routine.id} failed:`, err.message);
      try {
        const dm = await registry.client.users.createDM(uid);
        await dm.send(`⚠️ Heartbeat error: ${err.message}`);
      } catch {}
      state.recordActivity({
        userId: uid, type: "heartbeat", prompt: routine.payload.slice(0, 500),
        response: err.message.slice(0, 2000), sessionId: existingSession || null,
        status: "error", duration: Date.now() - start, routineId: routine.id,
      });
    }
    return;
  }

  // message / llm routines require a channel
  let ch;
  try {
    ch = await registry.client.channels.fetch(routine.channelId);
  } catch {
    ch = null;
  }
  if (!ch?.isTextBased()) {
    // Channel deleted or inaccessible — try DM as fallback
    try {
      const dm = await registry.client.users.createDM(routine.userId);
      await dm.send({
        content: `⏰ **Reminder** — (channel <#${routine.channelId}> unavailable)\n${routine.payload}`,
        allowedMentions: { users: [routine.userId] },
      });
      console.log(`[routines] routine ${routine.id} sent via DM fallback (channel unavailable)`);
      return;
    } catch (dmErr) {
      throw new Error(`Channel ${routine.channelId} not found and DM fallback failed: ${dmErr.message}`);
    }
  }

  if (routine.type === "message") {
    console.log(`[routines] firing message routine ${routine.id} uid=${routine.userId} cid=${routine.channelId}`);
    await ch.send({
      content: `⏰ **Reminder** — <@${routine.userId}>\n${routine.payload}`,
      allowedMentions: { users: [routine.userId] },
    });
    state.recordActivity({
      userId: routine.userId, channelId: routine.channelId, type: "reactive",
      prompt: routine.payload.slice(0, 500), status: "success", duration: 0,
      routineId: routine.id,
    });
    return;
  }

  const sandboxUrl = await ensureUserSandbox(routine.userId);
  if (!sandboxUrl) {
    await ch.send({
      content: `⚠️ <@${routine.userId}> Scheduled automation failed — sandbox unreachable.`,
      allowedMentions: { users: [routine.userId] },
    });
    throw new Error(`sandbox unreachable for routine ${routine.id}`);
  }

  const uid = routine.userId;
  const cid = routine.channelId;
  const prompt = `[user:${uid}] (scheduled routine): ${routine.payload}`;
  const start = Date.now();

  console.log(`[routines] firing llm routine ${routine.id} uid=${uid} cid=${cid}`);
  const sessionId = routine.isolatedSession ? null : store.getSession(cid);
  const res = await withUserRunLock(uid, () =>
    runAgent(prompt, sessionId, null, null, uid),
  );
  if (!routine.isolatedSession) store.setSession(cid, res.sessionId);

  const filesToSend = [];

  const { clean: textAfterMemory, saved, dropped } = persistMemoryTags(res.text, uid, cid);
  const { clean: textAfterAttachments, attachments } = extractAttachments(textAfterMemory);

  for (const relPath of attachments) {
    try {
      const f = await getFile(relPath, uid);
      pushFile(filesToSend, f.buffer, f.name);
    } catch (err) {
      console.error(`[routines] attachment fetch "${relPath}" failed:`, err.message);
    }
  }

  let out = textAfterAttachments || "";
  const { clean: textAfterEmbeds, embeds, errors: embedErrors } = extractEmbeds(out);
  const { clean: textAfterQuestions, questions } = extractQuestions(textAfterEmbeds);
  out = textAfterQuestions || "";

  const notes = [];
  if (saved) notes.push(`remembered ${saved}`);
  if (dropped) notes.push(`forgot ${dropped}`);
  if (oversizeNote(filesToSend)) notes.push(oversizeNote(filesToSend));
  if (embedErrors.length) notes.push(embedErrors.join("; "));
  if (notes.length) out += (out ? "\n\n" : "") + `_🧠 ${notes.join(", ")}_`;

  // Attribution label at the very bottom. NOTE: routines send via chunk()
  // directly, NOT through handleChat — keep it that way or labels double up.
  const label = labelLineFor(uid);
  if (label) out += label;

  const sendable = filesToSend.filter((f) => !f.oversize);
  if (!out && sendable.length === 0 && embeds.length === 0 && questions.length === 0) {
    out = "_(routine completed, no output)_";
  }

  const header = `🤖 **Scheduled automation** — <@${routine.userId}>\n`;
  const parts = chunk(header + out);
  for (let i = 0; i < parts.length; i++) {
    const options = {
      content: parts[i],
      allowedMentions: { parse: [], users: [routine.userId] },
    };
    if (i === 0) {
      if (sendable.length > 0) options.files = sendable;
      if (embeds.length > 0) options.embeds = embeds;
    }
    await ch.send(options);
  }
  for (const q of questions) {
    await sendQuestion(ch, q, uid);
  }
  state.recordActivity({
    userId: uid, channelId: cid, type: "reactive",
    prompt: routine.payload.slice(0, 500),
    response: (out || "").slice(0, 2000), sessionId: res.sessionId, status: "success",
    duration: Date.now() - start, routineId: routine.id,
    ...statistics.tokenFieldsFromAgent(res),
  });
}

function verifyRoutineUser(bodyUserId, authUserId) {
  if (!authUserId) return null;
  if (bodyUserId && authUserId !== bodyUserId) {
    const err = new Error("userId does not match the authenticated sandbox owner");
    err.status = 403;
    throw err;
  }
  return authUserId;
}

export { fireRoutine, verifyRoutineUser };
