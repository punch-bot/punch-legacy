
import console from "node:console";
import { SimpleMarkdown, rulesExtended } from "discord-markdown-parser";

const WORD_END = /[\p{L}\p{N}]$/u;
const DELIMITERS = "\\*_~|`";

const CONTAINERS = {
  em: (c) => ({ offset: 1, content: c[2] || c[1] }),
  strong: (c) => ({ offset: 2, content: c[1] }),
  underline: (c) => ({ offset: 2, content: c[1] }),
  strikethrough: (c) => ({ offset: 2, content: c[1] }),
  spoiler: (c) => ({ offset: 2, content: c[1] }),
  link: (c) => ({ offset: 1, content: c[1] }),
  heading: (c) => ({ offset: c[0].match(/^#{1,3} +/)[0].length + c[2].length - c[2].trimStart().length, content: c[2].trim() }),
  subtext: (c) => ({ offset: c[0].match(/^-# +/)[0].length, content: c[1] }),
};

const DELIMITER_SENSITIVE = new Set(["em", "strong", "underline", "strikethrough", "spoiler"]);
const closeDependsOnUnderscore = (type, raw) => type === "strikethrough" || (type === "em" && raw[0] === "_");
const SCANNING_DELIMITERS = { em: "*_", strong: "*", underline: "_", strikethrough: "~", spoiler: "|", inlineCode: "`", codeBlock: "`", link: "[" };

function matchText(source, seg) {
  if (!seg.textStops) {
    const text = seg.text;
    const stops = new Uint32Array(text.length + 1);
    stops[text.length] = text.length;
    let colonWord = false;
    for (let i = text.length - 1; i >= 0; i -= 1) {
      colonWord = /\w/.test(text[i]) && (colonWord || (text[i + 1] === ":" && /\S/.test(text[i + 2] || "")));
      stops[i] = colonWord || text[i] === "\n" || !/[0-9A-Za-z\s]/.test(text[i]) ? i : stops[i + 1];
    }
    seg.textStops = stops;
  }
  const local = seg.text.length - source.length;
  return Object.assign([source.slice(0, seg.textStops[local + 1] - local)], { index: 0 });
}

function quoteSegment(raw, at) {
  const block = raw.match(/^ *>>> ?/);
  if (block) {
    return { prefix: block[0], content: raw.slice(block[0].length), at: (i) => at(block[0].length + i) };
  }
  const map = [];
  let content = "";
  let lineStart = 0;
  for (const line of raw.split(/(?<=\n)/)) {
    const prefix = line.match(/^ *> ?/)[0].length;
    for (let k = prefix; k < line.length; k += 1) map.push(at(lineStart + k));
    content += line.slice(prefix);
    lineStart += line.length;
  }
  map.push(at(raw.length));
  return { prefix: null, content, at: (i) => map[i] };
}

function escapeEdits(state, seg, local, raw) {
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (!DELIMITERS.includes(ch)) continue;
    const at = seg.at(local + i);
    if (!seg.escapable && !(seg.intrawordEscapable && state.intraword.has(at))) continue;
    if (ch === "*" && seg.text[local + i + 1] === " " && /(^|\n) *$/.test(seg.text.slice(0, local + i))) continue;
    state.edits.push({ at, end: at, ins: "\\", risky: !seg.escapable });
  }
}

function track(type, rule) {
  const container = CONTAINERS[type];
  return {
    ...rule,
    match(source, state, prevCapture) {
      if (state.seg.depth > 100) throw new Error("markdown nesting limit");
      if (SCANNING_DELIMITERS[type]?.includes(source[0])) {
        state.work.remaining -= source.length;
        if (state.work.remaining < 0) throw new Error("markdown parsing budget");
      }
      state.local = state.seg.text.length - source.length;
      if (type === "text") return matchText(source, state.seg);
      if (type === "em" && !state.exact && source[0] === "_" && WORD_END.test(prevCapture)) {
        state.intraword.add(state.seg.at(state.local));
        return null;
      }
      return rule.match(source, state, prevCapture);
    },
    parse(capture, parse, state) {
      if (++state.work.nodes > 20_000) throw new Error("markdown node limit");
      const seg = state.seg;
      const local = state.local;
      const raw = capture[0];
      const start = seg.at(local);
      if (seg.depth === 0) state.top.push({ type, start, end: seg.at(local + raw.length), capture });

      if (type === "text") {
        escapeEdits(state, seg, local, raw);
        return rule.parse(capture, parse, state);
      }

      let inner = null;
      if (container) {
        const { offset, content } = container(capture);
        inner = { text: content, at: (i) => seg.at(local + offset + i) };
      } else if (type === "blockQuote") {
        const quote = quoteSegment(raw, (i) => seg.at(local + i));
        inner = { text: quote.content, at: quote.at };
        if (quote.prefix) {
          state.edits.push({ at: start, end: start + quote.prefix.length, ins: "> " });
          const body = quote.content.replace(/\n+$/, "");
          for (let i = 0; i < body.length; i += 1) {
            if (body[i] === "\n") state.edits.push({ at: quote.at(i) + 1, end: quote.at(i) + 1, ins: "> " });
          }
        }
      }
      if (!inner) return rule.parse(capture, parse, state);

      state.seg = {
        text: inner.text,
        at: inner.at,
        depth: seg.depth + 1,
        escapable: seg.escapable && !DELIMITER_SENSITIVE.has(type),
        intrawordEscapable: seg.intrawordEscapable && !closeDependsOnUnderscore(type, raw),
      };
      try {
        return rule.parse(capture, parse, state);
      } finally {
        state.seg = seg;
      }
    },
  };
}

const parser = SimpleMarkdown.parserFor(
  Object.fromEntries(Object.entries(rulesExtended).map(([type, rule]) => [type, track(type, rule)])),
);

function normalize(text) {
  let out = "";
  const map = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\f") continue;
    if (ch === "\t") {
      out += "    ";
      map.push(i, i + 1, i + 1, i + 1);
    } else if (ch === "\r") {
      out += "\n";
      map.push(i);
      if (text[i + 1] === "\n") i += 1;
    } else {
      out += ch;
      map.push(i);
    }
  }
  map.push(text.length);
  return { text: out, map };
}

function analyze(text, { exact = false } = {}) {
  const { text: source, map } = normalize(text);
  const state = {
    inline: true,
    exact,
    seg: { text: source, at: (i) => i, depth: 0, escapable: true, intrawordEscapable: true },
    top: [],
    edits: [],
    intraword: new Set(),
    work: { remaining: 4_000_000 + source.length * 4, nodes: 0 },
  };
  const ast = parser(source, state);
  return {
    ast,
    top: state.top.map((n) => ({ ...n, start: map[n.start], end: map[n.end] })),
    edits: state.edits.map((e) => ({ ...e, at: map[e.at], end: map[e.end] })),
  };
}

function applyEdits(text, edits) {
  let out = "";
  let cursor = 0;
  for (const edit of [...edits].sort((a, b) => a.at - b.at)) {
    out += text.slice(cursor, edit.at) + edit.ins;
    cursor = edit.end;
  }
  return out + text.slice(cursor);
}

function renderShape(nodes) {
  const out = [];
  for (const node of nodes) {
    const value = { ...node };
    if (Array.isArray(value.content)) value.content = renderShape(value.content);
    if (value.type === "text" && out.at(-1)?.type === "text") out.at(-1).content += value.content;
    else out.push(value);
  }
  return out;
}

function escapePlainText(text) {
  const { ast, edits } = analyze(text);
  const escaped = applyEdits(text, edits);
  if (edits.some((e) => e.risky) &&
      JSON.stringify(renderShape(analyze(escaped, { exact: true }).ast)) !== JSON.stringify(renderShape(ast))) {
    return applyEdits(text, edits.filter((e) => !e.risky));
  }
  return escaped;
}

function escapeAll(text) {
  return text.replace(/\\[^0-9A-Za-z\s]|[\\*_~|`<>#@[\]]/g, (m) => (m.length === 2 ? m : `\\${m}`));
}

function literalize(text, node) {
  const raw = text.slice(node.start, node.end);
  const plain = escapeAll(raw);
  return escapePlainText(text.slice(0, node.start) + plain + text.slice(node.end));
}

const PROBE = "\n\nx_ x* x** x__ x~~ x|| x` x`` x```\n";

function seal(text) {
  let out = text;
  for (let round = 0; round < 50; round += 1) {
    const leak = analyze(out + PROBE, { exact: true }).top.find((n) => n.start < out.length && n.end > out.length + 1);
    if (!leak) return out;
    const node = analyze(out, { exact: true }).top.find((n) => n.start <= leak.start && leak.start < n.end);
    out = node ? literalize(out, node) : null;
    if (out == null) break;
  }
  throw new Error("reply could not be sealed");
}

export function escapeStrayMarkdown(text) {
  const source = String(text || "");
  if (!source) return source;
  try {
    let out = source;
    for (let round = 0; round < 8; round += 1) {
      const next = seal(escapePlainText(out));
      if (next === out) return out;
      out = next;
    }
    throw new Error("markdown edits did not converge");
  } catch (err) {
    console.warn("[markdown] escaping all delimiters:", err.message);
    return escapeAll(source);
  }
}

export function notesFooter(notes) {
  if (!notes.length) return "";
  const text = notes.join(", ");
  let body;
  try {
    body = analyze(text, { exact: true }).top.map((node) => {
      const raw = text.slice(node.start, node.end);
      return node.type === "inlineCode" && !raw.includes("_") ? raw : escapeAll(raw);
    }).join("");
  } catch {
    body = escapeAll(text);
  }
  return `_🧠 ${body}_`;
}

function safeHardCut(text, from, to) {
  let cut = to;
  let slashes = 0;
  while (cut - slashes - 1 >= from && text[cut - slashes - 1] === "\\") slashes += 1;
  if (slashes % 2 === 1) cut -= 1;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return cut > from ? cut : to;
}

function plainChunks(text, size) {
  const out = [];
  let pos = 0;
  while (text.length - pos > size) {
    let cut = text.lastIndexOf("\n", pos + size);
    if (cut < pos + size * 0.5) cut = safeHardCut(text, pos, pos + size);
    out.push(text.slice(pos, cut));
    pos = cut;
  }
  if (pos < text.length) out.push(text.slice(pos));
  return out;
}

function containerParts(raw, node) {
  const normalized = normalize(raw);
  if (normalized.text !== node.capture[0]) return null;
  const c = node.capture;
  let start;
  let length;
  switch (node.type) {
    case "em":
      [start, length] = [1, (c[2] || c[1]).length];
      break;
    case "strong":
    case "underline":
    case "strikethrough":
    case "spoiler":
      [start, length] = [2, c[1].length];
      break;
    case "link":
      [start, length] = [1, c[1].length];
      break;
    case "heading":
      [start, length] = [c[0].match(/^#{1,3} +/)[0].length, c[2].length];
      break;
    case "subtext":
      [start, length] = [c[0].match(/^-# +/)[0].length, c[1].length];
      break;
    case "inlineCode":
      start = c[0].match(/^`+/)[0].length;
      length = c[0].length - 2 * start;
      break;
    case "codeBlock":
      return { open: `\`\`\`${c[2] || ""}\n`, content: c[3], close: "\n```" };
    case "blockQuote": {
      const body = raw.replace(/\r?\n$/, "");
      return { open: "> ", content: quoteSegment(c[0].replace(/\n$/, ""), (i) => i).content, close: raw.slice(body.length), quote: true };
    }
    default:
      return null;
  }
  const from = normalized.map[start];
  const to = normalized.map[start + length];
  return { open: raw.slice(0, from), content: raw.slice(from, to), close: raw.slice(to) };
}

function styledRuns(nodes, path = [], out = []) {
  for (const node of nodes) {
    const { content, ...style } = node;
    if (Array.isArray(content)) {
      styledRuns(content, [...path, style], out);
    } else {
      const key = JSON.stringify(node.type === "text" ? path : [...path, style]);
      const text = typeof content === "string" ? content.replace(/\s/g, "") : JSON.stringify(style);
      if (!text || node.type === "br" || node.type === "newline") continue;
      if (out.at(-1)?.key === key) out.at(-1).text += text;
      else out.push({ key, text });
    }
  }
  return out;
}

function cutPoints(text, top) {
  const points = new Set();
  for (const n of top) {
    points.add(n.end);
    if (n.type !== "text") continue;
    for (let i = n.start + 1; i < n.end; i += 1) if (/\s/.test(text[i])) points.add(i);
  }
  return [...points].sort((a, b) => b - a);
}

function splitContainer(rest, node, size, depth = 0) {
  if (depth > 50) return null;
  const raw = rest.slice(node.start, node.end);
  const parts = containerParts(raw, node);
  if (!parts) return null;
  const { open, content, close, quote } = parts;
  const before = rest.slice(0, node.start);
  const after = rest.slice(node.end);
  const lineClose = close.replace(/\r?\n$/, "");
  let inner;
  try {
    inner = analyze(content, { exact: true }).top;
  } catch {
    return null;
  }
  const budget = size - before.length - open.length - lineClose.length;
  if (budget < 2) return null;
  const wrap = (body, ending) => open + (quote ? body.replace(/\n/g, "\n> ") : body) + ending;
  const original = JSON.stringify(styledRuns(analyze(rest, { exact: true }).ast));
  const verify = (first, second, midLine) => {
    if (!first || !second) return null;
    const opaque = node.type === "inlineCode" || node.type === "codeBlock";
    const head = before + wrap(opaque ? first : first.trimEnd(), lineClose);
    if (!opaque && midLine) second = asMidLine(second);
    const tail = wrap(opaque ? second : second.trimStart(), close) + after;
    if (head.length > size || !head.trim()) return null;
    try {
      const headAst = analyze(head, { exact: true }).ast;
      const tailAst = analyze(tail, { exact: true }).ast;
      if (JSON.stringify(styledRuns([...headAst, ...tailAst])) !== original) return null;
    } catch {
      return null;
    }
    return [head, tail];
  };
  const points = cutPoints(content, inner).filter((k) => k > 0 && k < content.length && k <= budget);
  for (const k of points.slice(0, 12)) {
    const result = verify(content.slice(0, k), content.slice(k), content[k - 1] !== "\n");
    if (result) return result;
  }
  const spanning = inner.find((n) => n.start < budget && n.end > budget);
  if (spanning && node.type !== "inlineCode") {
    let nestedBudget = budget;
    for (let attempt = 0; attempt < 12 && nestedBudget > 0; attempt += 1) {
      const nested = splitContainer(content, spanning, nestedBudget, depth + 1);
      if (!nested) break;
      const result = verify(...nested, false);
      if (result) return result;
      const excess = before.length + wrap(nested[0], lineClose).length - size;
      if (excess <= 0) break;
      nestedBudget -= excess;
    }
  }
  let k = safeHardCut(content, 0, Math.min(budget, content.length - 1));
  for (let attempt = 0; k > 0 && attempt < 12; attempt += 1) {
    const result = verify(content.slice(0, k), content.slice(k), content[k - 1] !== "\n");
    if (result) return result;
    const excess = before.length + wrap(content.slice(0, k), lineClose).length - size;
    if (excess <= 0) break;
    k = safeHardCut(content, 0, k - excess);
  }
  return null;
}

function asMidLine(text) {
  const normalized = normalize(text);
  const match = normalized.text.match(/^( *)(>|#{1,3} |-# |[-*+] |\d+\. )/);
  if (!match) return text;
  const offset = match[1].length + (/^\d/.test(match[2]) ? match[2].indexOf(".") : 0);
  const at = normalized.map[offset];
  return text.slice(0, at) + "\\" + text.slice(at);
}

export function splitMarkdown(text, size = 1900) {
  if (!text) return [];
  const out = [];
  let rest = text;
  for (let guard = 0; rest.length > size; guard += 1) {
    let top;
    try {
      if (guard > 1000) throw new Error("too many splits");
      top = analyze(rest, { exact: true }).top;
    } catch (err) {
      console.warn("[markdown] splitting as plain text:", err.message);
      return [...out, ...plainChunks(rest, size)].filter((part) => part.trim());
    }

    const ends = top.map((n) => n.end).filter((e) => e <= size);
    const atLineBreak = (e) => rest[e - 1] === "\n" || rest[e] === "\n";
    const latest = (list) => Math.max(...list, -1);
    let cut = latest(ends.filter((e) => e >= size / 2 && atLineBreak(e)));
    if (cut < 0) cut = latest(ends.filter((e) => e >= size / 2));

    const spanning = top.find((n) => n.start < size && n.end > size);
    if (cut < 0 && spanning?.start > 0 && spanning.end - spanning.start <= size) cut = spanning.start;
    if (cut < 0 && spanning?.type === "codeBlock") {
      const lang = spanning.capture[0].match(/^```[a-z0-9_+\-.#]*\n/i);
      const open = lang ? lang[0] : "```\n";
      const bodyStart = spanning.start + (lang ? lang[0].length : 3);
      const close = "\n```";
      let lineCut = rest.lastIndexOf("\n", size - close.length);
      if (lineCut <= bodyStart) lineCut = safeHardCut(rest, bodyStart, size - close.length);
      if (lineCut > bodyStart) {
        const resume = rest[lineCut] === "\n" ? lineCut + 1 : lineCut;
        out.push(rest.slice(0, lineCut) + close);
        rest = open + rest.slice(resume);
        continue;
      }
    }
    if (cut < 0 && spanning) {
      const split = splitContainer(rest, spanning, size);
      if (split) {
        out.push(split[0]);
        rest = split[1];
        continue;
      }
    }
    if (cut <= 0) cut = latest(cutPoints(rest, top).filter((p) => p > 0 && p <= size));
    if (cut <= 0) {
      cut = safeHardCut(rest, 0, size);
      const node = top.find((n) => n.start < cut && n.end > cut);
      const tailEnd = node ? node.end : cut;
      out.push(rest.slice(0, cut));
      rest = escapeStrayMarkdown(rest.slice(cut, tailEnd)) + rest.slice(tailEnd);
      continue;
    }
    out.push(rest.slice(0, cut));
    rest = rest[cut - 1] === "\n" ? rest.slice(cut) : asMidLine(rest.slice(cut));
  }
  if (rest) out.push(rest);
  return out.filter((part) => part.trim());
}
