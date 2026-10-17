import type { ExtensionAPI } from "@punch-bot/cli";
import { readFile } from "node:fs/promises";
import { Type } from "typebox";

// Deployment bridge to the bot-owned store. Project memory stays local and is
// read only on demand, alongside remote recall in the same tool invocation.
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
        const token = process.env.PUNCH_BOT_TOKEN;
        if (!token) throw new Error("Punch memory recall is not configured for this sandbox.");
        const response = await fetch("http://bot:4098/memory/recall", {
          method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ query: args.query, contextId: args.contextId, maxChars: 4_000 }),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
        });
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
}
