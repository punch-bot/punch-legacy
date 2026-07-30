export const STATE_VERSION = 1;
export const STATE_TYPE = "punch-context-pruning";
export const MAX_SUMMARY_CHARS = 16_000;
const MIN_SUMMARY_ABSOLUTE = 20;
const MIN_SUMMARY_RATIO = 0.03;
const SMALL_RANGE_CHARS = 500;
const PLACEHOLDER_PATTERNS = [/^\.\.\.$/s, /^see above$/i, /^same as above$/i, /^n\/a\.?$/i, /^\[.*\]$/s];

function isValidSummary(summary, sourceCharacters) {
  if (typeof summary !== "string" || !summary.trim()) return false;
  if (PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(summary.trim()))) return false;
  if (sourceCharacters < SMALL_RANGE_CHARS) return true;
  if (summary.trim().length < MIN_SUMMARY_ABSOLUTE) return false;
  if (summary.trim().length > sourceCharacters) return false;
  if (summary.trim().length < sourceCharacters * MIN_SUMMARY_RATIO) return false;
  return true;
}

export const PROTECTED_TOOL_PATTERNS = [
  /^compress_context$/,
  /^decompress_context$/,
  /^recompress_context$/,
  /^context_status$/,
  /^search_context$/,
  /^task$/,
  /^summarize/,
];

export function emptyState() {
  return { version: STATE_VERSION, nextBlockId: 1, blocks: [] };
}

export function normalizeState(value) {
  if (!value || value.version !== STATE_VERSION || !Array.isArray(value.blocks)) return emptyState();
  const blocks = value.blocks.filter((block) =>
    block && typeof block.id === "string" && Array.isArray(block.messageIds) && typeof block.summary === "string",
  );
  const nextBlockId = Number.isInteger(value.nextBlockId) && value.nextBlockId > 0
    ? value.nextBlockId
    : blocks.length + 1;
  return { version: STATE_VERSION, nextBlockId, blocks };
}

export function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

export function messageRecords(entries) {
  const records = [];
  for (const entry of entries) {
    if (entry?.type !== "message" || !entry.id || !entry.message) continue;
    records.push({ id: entry.id, message: entry.message });
  }
  return records;
}

export function activeBlocks(state) {
  return normalizeState(state).blocks.filter((block) => block.active !== false);
}

export function activeMessageIds(state) {
  const ids = new Set();
  for (const block of activeBlocks(state)) {
    for (const id of block.messageIds) ids.add(id);
  }
  return ids;
}

export function createBlock(state, records, { startId, endId, topic, summary }) {
  const next = normalizeState(state);
  if (typeof summary !== "string" || !summary.trim()) throw new Error("summary is required");
  if (summary.length > MAX_SUMMARY_CHARS) throw new Error(`summary exceeds ${MAX_SUMMARY_CHARS} characters`);
  const start = records.findIndex((record) => record.id === startId);
  const end = records.findIndex((record) => record.id === endId);
  if (start < 0 || end < 0) throw new Error("boundaries must reference current conversation messages");
  if (start > end) throw new Error("startId must precede endId");
  if (records[start]?.message?.role !== "user" || records[end]?.message?.role !== "user") {
    throw new Error("boundaries must reference user messages");
  }
  const firstUser = records.find((record) => record.message?.role === "user");
  if (startId === firstUser?.id) throw new Error("first user message is protected");
  const rangeRecords = records.slice(start, end + 1);
  const messageIds = rangeRecords.map((record) => record.id);
  if (rangeRecords.some((record) => {
    const toolName = record.message?.toolName || (record.message?.role === "tool" && record.message?.name);
    return toolName && PROTECTED_TOOL_PATTERNS.some((pattern) => pattern.test(toolName));
  })) throw new Error("range contains protected tool output — decompress or skip that turn");
  const compressed = activeMessageIds(next);
  if (messageIds.some((id) => compressed.has(id))) throw new Error("range overlaps an active compressed block");
  const sourceCharacters = records.slice(start, end + 1)
    .reduce((total, record) => total + textFromContent(record.message?.content).length, 0);
  if (!isValidSummary(summary, sourceCharacters)) throw new Error(
    `summary is too short, too vague, or longer than source for a ${sourceCharacters}-character range`,
  );
  const block = {
    id: `b${next.nextBlockId}`,
    tier: 1,
    active: true,
    anchorId: startId,
    startId,
    endId,
    messageIds,
    topic: typeof topic === "string" ? topic.slice(0, 120) : "",
    summary: summary.trim(),
    sourceCharacters,
    createdAt: Date.now(),
  };
  return { ...next, nextBlockId: next.nextBlockId + 1, blocks: [...next.blocks, block] };
}

export function recompressBlock(state, blockIds, { summary, topic }) {
  const next = normalizeState(state);
  if (typeof summary !== "string" || !summary.trim()) throw new Error("summary is required");
  if (summary.length > MAX_SUMMARY_CHARS) throw new Error(`summary exceeds ${MAX_SUMMARY_CHARS} characters`);
  if (!Array.isArray(blockIds) || blockIds.length < 2) throw new Error("need at least 2 deactivated blocks to recompress");
  const parents = [];
  const allMessageIds = [];
  let sourceCharacters = 0;
  for (const id of blockIds) {
    const block = next.blocks.find((b) => b.id === id);
    if (!block) throw new Error(`block ${id} not found`);
    if (block.active !== false) throw new Error(`block ${id} must be deactivated first`);
    parents.push(block);
    allMessageIds.push(...block.messageIds);
    sourceCharacters += block.sourceCharacters || 0;
  }
  if (!isValidSummary(summary, sourceCharacters)) throw new Error(
    `recompressed summary is too short, too vague, or longer than source for ${sourceCharacters} source characters`,
  );
  const firstAnchor = parents[0].anchorId || parents[0].messageIds[0];
  if (!firstAnchor) throw new Error("parent blocks have no anchor");
  const active = activeMessageIds(next);
  if (allMessageIds.some((id) => active.has(id))) throw new Error("some parent message ids are in active blocks");
  const block = {
    id: `b${next.nextBlockId}`,
    tier: 2,
    active: true,
    anchorId: firstAnchor,
    parentBlockIds: blockIds,
    messageIds: allMessageIds,
    topic: typeof topic === "string" ? topic.slice(0, 120) : "",
    summary: summary.trim(),
    sourceCharacters,
    createdAt: Date.now(),
  };
  return { ...next, nextBlockId: next.nextBlockId + 1, blocks: [...next.blocks, block] };
}

export function deactivateBlock(state, id) {
  const next = normalizeState(state);
  let changed = false;
  const blocks = next.blocks.map((block) => {
    if (block.id !== id || block.active === false) return block;
    changed = true;
    return { ...block, active: false, restoredAt: Date.now() };
  });
  if (!changed) throw new Error(`active block ${id} not found`);
  return { ...next, blocks };
}

export function blockPreview(records, block, maxCharacters = 4_000) {
  const selected = new Set(block.messageIds);
  let text = "";
  for (const record of records) {
    if (!selected.has(record.id)) continue;
    const body = textFromContent(record.message?.content).trim();
    if (!body) continue;
    const section = `[${record.message.role}]\n${body}\n\n`;
    if (text.length + section.length > maxCharacters) {
      return `${text.slice(0, maxCharacters)}\n[preview truncated]`;
    }
    text += section;
  }
  return text || "[No text content in this range]";
}

export function searchBlocks(state, query, limit = 5) {
  const terms = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return activeBlocks(state)
    .map((block) => {
      const haystack = `${block.topic}\n${block.summary}`.toLowerCase();
      return { block, score: terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0) };
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || b.block.createdAt - a.block.createdAt)
    .slice(0, limit);
}
