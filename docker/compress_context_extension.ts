import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (_pi: ExtensionAPI) {
  _pi.on("before_agent_start", async (event) => {
    let memory = "";
    try {
      memory = (await readFile("/work/.punch-memory.md", "utf8")).trim().slice(0, 12_000);
    } catch {}
    if (!memory) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n## Persistent project memory\nTreat this as durable project context. Update /work/.punch-memory.md when needed.\n\n${memory}`,
    };
  });

  _pi.registerTool({
    name: "compress_context",
    label: "Compress conversation context",
    description:
      "Request whole-session compaction after this turn. Call this when the conversation history is getting long or you are context-constrained.",
    promptSnippet:
      "Before requesting compaction, save important info to /work/.punch-memory.md with the write tool.",
    promptGuidelines: [
      "Call this when the conversation history is getting long and you feel your context window filling up.",
      "Before calling, review the conversation for important project info, decisions, user preferences, or anything worth keeping and append it to /work/.punch-memory.md using the write tool.",
      "After calling, include <compress></compress> in your reply text. Punch will compact after this turn finishes.",
    ],
    parameters: Type.Object({
      userId: Type.String({
        description: "Discord user ID from speaker tag id:NUMBER",
      }),
    }),

    async execute(_toolCallId, args) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              "To request compaction after this turn, include <compress></compress> in your reply after saving durable context.",
          },
        ],
      };
    },
  });
}
