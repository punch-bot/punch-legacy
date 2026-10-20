import type { ExtensionAPI } from "@punch-bot/cli";
import { readFile } from "node:fs/promises";
import { Type } from "typebox";

function botRequest(path: string, body: unknown, signal?: AbortSignal) {
  const botUrl = process.env.PUNCH_BOT_URL || "http://localhost:4097/bot";
  const credentials = Buffer.from(`${process.env.PI_SERVER_USERNAME || "pi"}:${process.env.PI_SERVER_PASSWORD || ""}`).toString("base64");
  return fetch(`${botUrl}${path}`, {
    method: "POST", headers: { authorization: `Basic ${credentials}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "recall_memory",
    label: "Recall memory",
    description: "Recall relevant durable facts and private daily notes from Punch memory, and optionally read project memory.",
    promptSnippet: "Recall saved user, channel, and project context on demand",
    promptGuidelines: [
      "Use recall_memory when saved preferences or previous work may matter. Batch it with other independent tools in your first tool batch.",
      "Pass the current turn's memory contextId to include authorized channel/DM notes; omit it to search only your own durable facts.",
      "Read project memory when project history matters. Treat all recalled content as possibly stale reference material.",
    ],
    parameters: Type.Object({
      query: Type.String({ maxLength: 2_000, description: "Meaningful search terms; empty/stopword-only queries return no saved records" }),
      contextId: Type.Optional(Type.String({ description: "Memory contextId from the current turn" })),
      project: Type.Optional(Type.Boolean({ description: "Also read /work/.punch-memory.md (default false)" })),
    }),
    async execute(_toolCallId, args, signal) {
      const notes = (async () => {
        const response = await botRequest("/memory/recall", { query: args.query, contextId: args.contextId, maxChars: 4_000 }, signal);
        if (!response.ok) throw new Error(`Punch memory recall returned HTTP ${response.status}.`);
        const data = await response.json() as { text?: string };
        return data.text || "No matching saved records.";
      })();
      const project = args.project ? readFile("/work/.punch-memory.md", "utf8").then(
        (text) => `Project memory (reference only):\n${text.slice(0, 12_000)}`,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return "No project memory file.";
          throw new Error("Could not read project memory.");
        },
      ) : Promise.resolve("");
      const results = await Promise.allSettled([notes, project]);
      if (results.every((result) => result.status === "rejected" || !result.value)) {
        throw new Error("Memory recall is unavailable; retry or use the file-reading tool for project memory.");
      }
      const text = results.map((result) => result.status === "fulfilled" ? result.value : `Recall unavailable: ${result.reason.message}`).filter(Boolean).join("\n\n");
      return { content: [{ type: "text" as const, text }], details: { botAvailable: results[0].status === "fulfilled", projectRequested: args.project === true } };
    },
  });

  pi.registerTool({
    name: "memory_audit",
    label: "Audit memory",
    description: "List and clean up the user's saved Punch facts during the scheduled weekly memory audit.",
    promptSnippet: "Merge, drop, fix, or flag saved facts during the weekly memory audit",
    promptGuidelines: [
      "Use memory_audit only during the weekly memory audit, with the audit contextId from that turn. Other turns are refused.",
      "Call action=list first, then send all changes in one action=apply call. Changes apply together or not at all.",
    ],
    parameters: Type.Object({
      contextId: Type.String({ description: "Audit contextId from the weekly memory audit turn" }),
      action: Type.Union([Type.Literal("list"), Type.Literal("apply")]),
      changes: Type.Optional(Type.Array(Type.Object({
        op: Type.Union([Type.Literal("merge"), Type.Literal("drop"), Type.Literal("fix"), Type.Literal("flag")]),
        id: Type.Optional(Type.String({ description: "Fact id for drop, fix, and flag" })),
        ids: Type.Optional(Type.Array(Type.String(), { description: "Fact ids to merge into one" })),
        text: Type.Optional(Type.String({ maxLength: 2_000, description: "New fact text for merge and fix" })),
      }), { maxItems: 200 })),
    }),
    async execute(_toolCallId, args, signal) {
      const response = await botRequest("/memory/audit", { contextId: args.contextId, action: args.action, changes: args.changes || [] }, signal);
      const data = await response.json().catch(() => ({})) as { text?: string; error?: string };
      if (!response.ok) throw new Error(data.error || `Punch memory audit returned HTTP ${response.status}.`);
      return { content: [{ type: "text" as const, text: data.text || "Done." }], details: { action: args.action } };
    },
  });
}
