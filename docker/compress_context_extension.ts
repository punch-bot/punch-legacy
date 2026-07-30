import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  STATE_TYPE,
  activeBlocks,
  activeMessageIds,
  blockPreview,
  createBlock,
  deactivateBlock,
  emptyState,
  messageRecords,
  normalizeState,
  searchBlocks,
  textFromContent,
} from "../context-pruning-state.mjs";

type PruningState = ReturnType<typeof emptyState>;

const textResult = (text: string) => ({ content: [{ type: "text" as const, text }] });

function loadState(ctx: ExtensionContext): PruningState {
  const entries = ctx.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as { type?: string; customType?: string; data?: unknown } | undefined;
    if (entry?.type === "custom" && entry.customType === STATE_TYPE) return normalizeState(entry.data);
  }
  return emptyState();
}

function saveState(pi: ExtensionAPI, state: PruningState) {
  pi.appendEntry(STATE_TYPE, state);
}

function records(ctx: ExtensionContext) {
  return messageRecords(ctx.sessionManager.buildContextEntries());
}

function messageSignature(message: { role?: string; content?: unknown; toolCallId?: string; toolName?: string }) {
  return JSON.stringify({
    role: message?.role,
    content: message?.content,
    toolCallId: message?.toolCallId,
    toolName: message?.toolName,
  });
}

function matchEntryIds(ctx: ExtensionContext, messages: Array<{ role?: string; content?: unknown }>) {
  const idsBySignature = new Map<string, string[]>();
  for (const record of records(ctx)) {
    const signature = messageSignature(record.message);
    const ids = idsBySignature.get(signature) ?? [];
    ids.push(record.id);
    idsBySignature.set(signature, ids);
  }
  return messages.map((message) => idsBySignature.get(messageSignature(message))?.shift());
}

function addMessageId(message: any, id: string) {
  if (message.role !== "user") return message;
  const marker = `\n\n<punch-message-id>${id}</punch-message-id>`;
  if (typeof message.content === "string") return { ...message, content: `${message.content}${marker}` };
  if (Array.isArray(message.content)) return {
    ...message,
    content: [...message.content, { type: "text", text: marker }],
  };
  return message;
}

function compressedSummary(block: PruningState["blocks"][number]) {
  const topic = block.topic ? `: ${block.topic}` : "";
  return {
    role: "custom" as const,
    customType: STATE_TYPE,
    content: `<compressed-context id="${block.id}">${topic}\n${block.summary}\n</compressed-context>`,
    display: false,
    timestamp: Date.now(),
  };
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    let memory = "";
    try {
      memory = (await readFile("/work/.punch-memory.md", "utf8")).trim().slice(0, 12_000);
    } catch {}
    const threshold = Number(event.systemPrompt.match(/PUNCH_CONTEXT_PRUNING_THRESHOLD=(\d+)/)?.[1] || 0);
    const usage = ctx.getContextUsage();
    const nudge = threshold > 0 && usage?.percent != null && usage.percent >= threshold
      ? `\n\n## Context pruning now\nContext is at ${Math.round(usage.percent)}%. Before continuing, selectively compress stale complete ranges with compress_context. Keep current work and recent turns available.`
      : "";
    if (!memory && !nudge) return;
    return {
      systemPrompt: `${event.systemPrompt}${memory ? `\n\n## Persistent project memory\nTreat this as durable project context. Update /work/.punch-memory.md when needed.\n\n${memory}` : ""}${nudge}`,
    };
  });

  pi.on("context", (event, ctx) => {
    const state = loadState(ctx);
    const blocks = activeBlocks(state);
    const ids = matchEntryIds(ctx, event.messages);
    const hidden = activeMessageIds(state);
    // Do not risk an orphaned tool result after Pi reshapes context for native compaction.
    if ([...hidden].some((id) => !ids.includes(id))) {
      return { messages: event.messages.map((message, index) => ids[index] ? addMessageId(message, ids[index]!) : message) };
    }

    const byAnchor = new Map(blocks.map((block) => [block.anchorId, block]));
    const messages: typeof event.messages = [];
    for (let index = 0; index < event.messages.length; index += 1) {
      const id = ids[index];
      const block = id ? byAnchor.get(id) : undefined;
      if (block) messages.push(compressedSummary(block));
      if (id && hidden.has(id)) continue;
      messages.push(id ? addMessageId(event.messages[index], id) : event.messages[index]);
    }
    return { messages };
  });

  pi.registerTool({
    name: "compress_context",
    label: "Compress context range",
    promptSnippet: "Compress stale complete conversation ranges when context is crowded; use visible punch-message-id values.",
    promptGuidelines: [
      "Before compression, save durable project facts to /work/.punch-memory.md.",
      "Only compress complete stale user-turn ranges. Keep active task discussion and recent turns visible.",
      "Supply a self-contained summary. The original session remains retrievable with decompress_context.",
    ],
    description: "Replace a stale range of complete conversation turns with your summary for future model calls. Boundaries must be visible user-message IDs. Original Pi session entries remain intact and can be restored with decompress_context.",
    executionMode: "sequential",
    parameters: Type.Object({
      startId: Type.String({ description: "Earlier visible user punch-message-id" }),
      endId: Type.String({ description: "Later visible user punch-message-id" }),
      summary: Type.String({ description: "Self-contained summary replacing the range" }),
      topic: Type.Optional(Type.String({ description: "Short range label" })),
    }),
    async execute(_toolCallId, args, _signal, _onUpdate, ctx) {
      const state = createBlock(loadState(ctx), records(ctx), args);
      saveState(pi, state);
      const block = state.blocks.at(-1)!;
      return textResult(`Compressed ${block.id}: ${block.messageIds.length} messages, ${block.sourceCharacters} source characters. Use decompress_context with ${block.id} to restore it.`);
    },
  });

  pi.registerTool({
    name: "decompress_context",
    label: "Restore context range",
    description: "Restore a previously compressed block for future model calls. Returns a bounded preview immediately; original Pi session entries are never deleted.",
    executionMode: "sequential",
    parameters: Type.Object({ blockId: Type.String({ description: "Active block ID, such as b1" }) }),
    async execute(_toolCallId, args, _signal, _onUpdate, ctx) {
      const state = loadState(ctx);
      const block = activeBlocks(state).find((candidate) => candidate.id === args.blockId);
      if (!block) throw new Error(`active block ${args.blockId} not found`);
      const next = deactivateBlock(state, args.blockId);
      saveState(pi, next);
      return textResult(`Restored ${args.blockId}. Preview:\n${blockPreview(records(ctx), block)}`);
    },
  });

  pi.registerTool({
    name: "context_status",
    label: "Context pruning status",
    description: "Show active compressed ranges and context usage.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _args, _signal, _onUpdate, ctx) {
      const state = loadState(ctx);
      const blocks = activeBlocks(state);
      const usage = ctx.getContextUsage();
      const lines = blocks.map((block) => `${block.id}: ${block.messageIds.length} messages, ${block.sourceCharacters} source characters${block.topic ? `, ${block.topic}` : ""}`);
      return textResult([
        `Active compressed blocks: ${blocks.length}.`,
        usage?.percent == null ? "Context usage unavailable." : `Context usage: ${Math.round(usage.percent)}%.`,
        lines.join("\n") || "No ranges compressed.",
      ].join("\n"));
    },
  });

  pi.registerTool({
    name: "search_context",
    label: "Search compressed context",
    description: "Search active compressed summaries before restoring a block.",
    parameters: Type.Object({ query: Type.String({ description: "Words to search" }) }),
    async execute(_toolCallId, args, _signal, _onUpdate, ctx) {
      const results = searchBlocks(loadState(ctx), args.query);
      if (!results.length) return textResult("No matching compressed blocks.");
      return textResult(results.map(({ block }) => `${block.id}${block.topic ? ` (${block.topic})` : ""}: ${block.summary.slice(0, 1_000)}`).join("\n\n"));
    },
  });
}
