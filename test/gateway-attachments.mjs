#!/usr/bin/env node
// Unit-check: tool image results map to data-URL attachments for collectTurnMedia.
function attachmentsFromToolResult(result) {
  const out = [];
  const content = result?.content;
  if (!Array.isArray(content)) return out;
  for (const part of content) {
    if (!part || part.type !== "image") continue;
    const data = typeof part.data === "string" ? part.data : "";
    if (!data) continue;
    const mime = part.mimeType || part.mime || "image/png";
    out.push({ mime, url: `data:${mime};base64,${data}` });
  }
  return out;
}

function textOutputFromToolResult(result) {
  if (typeof result === "string") return result;
  if (Array.isArray(result?.content)) {
    const texts = result.content
      .filter((p) => p && p.type === "text" && p.text)
      .map((p) => p.text);
    const nImg = result.content.filter((p) => p && p.type === "image").length;
    let text = texts.join("\n");
    if (nImg) text += (text ? "\n" : "") + `[${nImg} image attachment(s)]`;
    if (text) return text;
  }
  return JSON.stringify(result ?? "");
}

const fakePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
).toString("base64");

const result = {
  content: [
    { type: "text", text: "Screenshot saved to /work/screenshots/example.png" },
    { type: "image", data: fakePng, mimeType: "image/png" },
  ],
  details: { path: "/work/screenshots/example.png" },
};

const attachments = attachmentsFromToolResult(result);
const output = textOutputFromToolResult(result);

if (attachments.length !== 1) throw new Error(`expected 1 attachment, got ${attachments.length}`);
if (!attachments[0].url.startsWith("data:image/png;base64,")) {
  throw new Error("bad data URL: " + attachments[0].url.slice(0, 40));
}
if (!output.includes("Screenshot saved") || !output.includes("[1 image attachment(s)]")) {
  throw new Error("bad text output: " + output);
}
if (output.includes(fakePng)) throw new Error("raw base64 leaked into output");

console.log("ok: gateway attachment mapping");
