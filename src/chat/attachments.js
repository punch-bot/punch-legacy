// Discord attachment download + sandbox upload + reply settlement helpers.

import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync, rmSync } from "node:fs";
import * as sandbox from "../sandbox-manager.js";
import { sandboxNameForUser } from "../agent.js";
import { MAX_UPLOAD, MAX_ATTACHMENT_BYTES } from "../core/config.js";
import { chunk } from "../core/discord.js";

export function pushFile(list, buffer, name) {
  if (!buffer || !buffer.length) return;
  list.push({ attachment: buffer, name, oversize: buffer.length > MAX_UPLOAD });
}

export function oversizeNote(files) {
  const n = files.filter((f) => f.oversize).length;
  return n ? `skipped ${n} file${n > 1 ? "s" : ""} over ${Math.round(MAX_UPLOAD / 1048576)}MB` : "";
}

// Download a Discord message's attachments for sandbox delivery.
// Each returned item is { mime, filename, data } where `data` is base64.
export async function downloadMessageAttachments(message) {
  const out = [];
  const skipped = [];
  const items = message?.attachments ? [...message.attachments.values()] : [];
  for (const att of items) {
    if (att.size > MAX_ATTACHMENT_BYTES) {
      skipped.push(att.name);
      continue;
    }
    try {
      const res = await fetch(att.url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) {
        console.error(`[attachments] download failed (${res.status}) for ${att.name}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      out.push({
        mime: att.contentType || "application/octet-stream",
        filename: att.name,
        data: buf.toString("base64"),
      });
    } catch (err) {
      console.error(`[attachments] download failed for ${att.name}:`, err.message);
    }
  }
  return { attachments: out, skipped };
}

// Write a downloaded attachment into the user's sandbox workspace so the agent
// can read/parse it with its file tools. Gateway message `file` parts do not
// accept inline data URLs (they 400), so we persist the bytes on disk and point
// the model at the path instead. Returns the workspace path or null on failure.
function sanitizeAttachName(n) {
  const base = String(n || "file").replace(/[\/\\]/g, "_").replace(/[^a-zA-Z0-9._-]/g, "_");
  return base.slice(0, 120) || "file";
}

export async function uploadToSandbox(userId, filename, buffer) {
  const name = sandboxNameForUser(userId);
  if (!name) return null;
  const container = sandbox.containerForSandbox(name);
  if (!container) return null;
  const safe = sanitizeAttachName(filename);
  const tmp = join(tmpdir(), `punch_att_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  try {
    writeFileSync(tmp, buffer);
    sandbox.ensureDirInContainer(container, "/work/attachments");
    sandbox.copyIntoContainer(container, tmp, `/work/attachments/${safe}`);
    return `/work/attachments/${safe}`;
  } catch (e) {
    console.error("[attachments] sandbox upload failed:", e.message);
    return null;
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function extractAttachments(textIn) {
  const paths = [];
  const text = String(textIn || "");
  const ATTACHMENT_RE = /<attachment\s+path="([^"]+)"\s*\/?>?\s*(?:<\/attachment\s*>)?|<attachment\s*>([\s\S]*?)<\/attachment>/gi;
  const clean = text.replace(ATTACHMENT_RE, (match, p1, p2) => {
    const p = (p1 || p2 || "").trim();
    if (p) paths.push(p);
    return "";
  }).trim();
  return { clean, attachments: paths };
}

export async function settle(message, text, files = [], rich = {}) {
  const embeds = rich.embeds || [];
  const parts = chunk(text);
  if (parts.length === 0) {
    if (files.length > 0 || embeds.length > 0) {
      await message.reply({
        files,
        embeds,
        allowedMentions: { parse: [], repliedUser: false },
      });
    }
  } else {
    for (let i = 0; i < parts.length; i++) {
      const options = {
        content: parts[i],
        allowedMentions: { parse: [], repliedUser: false },
      };
      if (i === 0) {
        if (files.length > 0) options.files = files;
        if (embeds.length > 0) options.embeds = embeds;
      }
      await message.reply(options);
    }
  }
}
