import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (_pi: ExtensionAPI) {
  _pi.registerTool({
    name: "compress_context",
    label: "Compress conversation context",
    description:
      "Signal that the conversation context should be compressed. Call this when the conversation history is getting long, tool outputs are piling up, or you feel context-constrained.",
    promptSnippet:
      "Compress conversation context when it's getting full. Before calling, save important info to /work/.punch-memory.md with the write tool.",
    promptGuidelines: [
      "Call this when the conversation history is getting long and you feel your context window filling up.",
      "Before calling, review the conversation for important project info, decisions, user preferences, or anything worth keeping and append it to /work/.punch-memory.md using the write tool.",
      "After calling, include <compress></compress> in your reply text so Punch triggers the session compaction.",
      "The actual compression happens after your turn finishes.",
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
              "Compression queued. include <compress></compress> in your reply so Punch compacts the session.",
          },
        ],
      };
    },
  });
}
