function splitKeepingFences(text) {
  const parts = [];
  let buffer = "";
  let open = null;
  for (const line of String(text || "").split("\n")) {
    const m = line.match(/^(\s*)([`~]+)(.*)$/);
    const run = m ? m[2] : "";
    if (open) {
      buffer += line + "\n";
      const closed =
        run &&
        run[0] === open.char &&
        run.length >= open.length &&
        m[3].trim() === "";
      if (closed) {
        parts.push({ code: true, text: buffer });
        buffer = "";
        open = null;
      }
      continue;
    }
    if (m && run.length >= 3 && !m[3].includes(run[0])) {
      if (buffer) parts.push({ code: false, text: buffer });
      open = { char: run[0], length: run.length };
      buffer = line + "\n";
      continue;
    }
    buffer += line + "\n";
  }
  if (buffer) parts.push({ code: Boolean(open), text: buffer });
  return parts;
}

function stripInlineCode(text) {
  return text.replace(/(^|[^`])(`+)([^`\n]*?)\2(?=$|[^`])/g, (match, pre, ticks, inner) => pre + "\u0000".repeat((ticks + inner + ticks).length));
}

const ITEM_MARKER = /(\*\*\d+[.)])|(\*\*[-•]|\*\*\w[^*]*:)/g;

function formatLine(line) {
  const stripped = stripInlineCode(line);
  if (!stripped || stripped.trim() === "") return line;

  const positions = [];
  ITEM_MARKER.lastIndex = 0;
  let m;
  while ((m = ITEM_MARKER.exec(stripped))) {
    const start = m.index;
    if (stripped.slice(0, start).trim() !== "") positions.push(start);
  }

  if (!positions.length) return line;

  let out = "";
  let cursor = 0;
  for (const pos of positions) {
    if (pos <= cursor) continue;
    out += line.slice(cursor, pos).trimEnd() + "\n";
    cursor = pos;
  }
  out += line.slice(cursor);
  return out;
}

export function formatReplyNewlines(text) {
  const source = String(text || "");
  const parts = splitKeepingFences(source);
  const out = parts
    .map((part) => (part.code ? part.text : part.text.split("\n").map(formatLine).join("\n")))
    .join("")
    .replace(/\n{3,}/g, "\n\n");
  if (!source.endsWith("\n")) return out.replace(/\n+$/, "");
  return out;
}
