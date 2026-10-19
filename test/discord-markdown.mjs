import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { parse } from "discord-markdown-parser";
import { escapeStrayMarkdown, notesFooter, splitMarkdown } from "../src/discord-markdown.js";

const FOOTER = "_🧠 context 94% (188k/200k) ⚠️ near full — consider `/compress` or `/reset`_";

function footerNode(body) {
  const nodes = parse(`${escapeStrayMarkdown(body)}\n\n${FOOTER}`, "extended");
  return nodes[nodes.length - 1];
}

test("a bare underscore in the reply can't capture the italic notes footer", () => {
  const body = "what keeps it honest is scan_slop, a linter that counts design tells";
  assert.equal(escapeStrayMarkdown(body), "what keeps it honest is scan\\_slop, a linter that counts design tells");
  const node = footerNode(body);
  assert.equal(node.type, "em");
  assert.deepEqual(node.content.at(-1), { type: "inlineCode", content: "/reset" });
});

test("no stray marker in the reply reaches the footer", () => {
  for (const body of ["**unclosed bold", "a stray || spoiler", "~~unclosed strike", "one ` tick", "```\nunclosed fence", ">>> quote to the end", "*star _under"]) {
    assert.equal(footerNode(body).type, "em", body);
  }
});

test("keeps formatting the reply actually uses", () => {
  for (const input of [
    "**bold** *it* ***both*** __under__ ___ui___ ~~gone~~ ||secret spoiler||",
    "**bold *italic* bold**",
    "snake case and _real italics_ here",
    "* bullet one\n* bullet two\n1. one\n- two",
    "# Heading\n-# subtext\n> quote\n> more",
    "use `a_b*c` here\n```js\nconst a_b = *x;\n```",
    "see https://x.com/a_b_c <https://y.com/_x_> [docs](https://a.com/x_y)",
    "<@123456789012345678> <:snake_case:123456789012345678> <t:1700000000:R>",
    "¯\\_(ツ)_/¯ and already \\_escaped\\_",
  ]) {
    assert.equal(escapeStrayMarkdown(input), input, input);
  }
});

test("escapes markers that render as plain text", () => {
  const cases = [
    ["snake_case_name", "snake\\_case\\_name"],
    ["**unclosed bold", "\\*\\*unclosed bold"],
    ["5 * 3 and a stray || here", "5 \\* 3 and a stray \\|\\| here"],
    ["*a _b* c_", "*a _b* c\\_"],
    ["[link_text](https://a.com/x_y)", "[link\\_text](https://a.com/x_y)"],
    ["C:\\Users\\me", "C:\\\\Users\\\\me"],
    ["```\nunclosed a_b", "\\`\\`\\`\nunclosed a\\_b"],
    ["**scan_slop and foo_**", "**scan\\_slop and foo\\_**"],
    ["tab\there_x\r\nnext_y", "tab\there\\_x\r\nnext\\_y"],
  ];
  for (const [input, expected] of cases) assert.equal(escapeStrayMarkdown(input), expected, input);
});

test("keeps the source of formatting it doesn't need to escape", () => {
  for (const input of ["~~~~~", "|||||", "~~a~b~~", "||a|b||", "*_\n\n¯\\_(ツ)_/¯*"]) {
    assert.equal(escapeStrayMarkdown(input), input, input);
  }
});

test("is idempotent", () => {
  for (const input of ["scan_slop", "**unclosed", "~~~~~", ">>> q_x\nline", "a ` b `c_d` e_"]) {
    const once = escapeStrayMarkdown(input);
    assert.equal(escapeStrayMarkdown(once), once, input);
  }
});

test("stays linear on long unbroken words", () => {
  const started = Date.now();
  escapeStrayMarkdown("a".repeat(80_000));
  assert.ok(Date.now() - started < 1000);
});

test("splits only between markdown nodes, so a cut can't expose an escaped marker", () => {
  const text = `${escapeStrayMarkdown(`${"x".repeat(1898)} scan_b`)}\n\n${FOOTER}`;
  const parts = splitMarkdown(text, 1900);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.length <= 1900));
  assert.equal(parts.join(""), text);
  assert.equal(parse(parts.at(-1), "extended").at(-1).type, "em");
});

test("splits an oversized code block into closed blocks that reopen the fence", () => {
  const lines = Array.from({ length: 120 }, (_, i) => `const line_${i} = "${"x".repeat(20)}";`);
  const text = escapeStrayMarkdown(`intro\n\`\`\`js\n${lines.join("\n")}\n\`\`\`\nafter_x`);
  const parts = splitMarkdown(text, 1900);
  assert.ok(parts.length >= 3);
  for (const part of parts) {
    assert.ok(part.length <= 1900);
    const nodes = parse(part, "extended");
    assert.ok(nodes.some((n) => n.type === "codeBlock" && n.lang === "js"), part.slice(0, 40));
    assert.ok(!nodes.some((n) => n.type === "text" && n.content.includes("`")), part.slice(0, 40));
  }
});

test("short text is a single part and empty text has none", () => {
  assert.deepEqual(splitMarkdown("hi _there_"), ["hi _there_"]);
  assert.deepEqual(splitMarkdown(""), []);
});

test("sends a construct whose parse depends on what follows it as plain text", () => {
  assert.equal(footerNode("___x__").type, "em");
  assert.equal(footerNode("****").type, "em");
});

test("parses tabs the way Discord does", () => {
  assert.equal(footerNode("|)[`\nb||~||](\\\t*`|)# b*>_").type, "em");
});

test("splits oversized formatting by closing and reopening it", () => {
  const text = `**${"lots of bold words ".repeat(200).trim()}**\n\n${FOOTER}`;
  const parts = splitMarkdown(text, 1900);
  assert.ok(parts.length >= 3);
  for (const part of parts.slice(0, -1)) {
    assert.ok(part.length <= 1900);
    const nodes = parse(part, "extended");
    assert.equal(nodes[0].type, "strong", part.slice(0, 30));
  }
  assert.equal(parse(parts.at(-1), "extended").at(-1).type, "em");
});

test("a cut mid-line doesn't start the next message with line-start syntax", () => {
  const text = `${"word ".repeat(10)}>>> not a quote ${"x".repeat(30)}\n\n${FOOTER}`;
  for (let size = 40; size < 120; size += 1) {
    const parts = splitMarkdown(text, size);
    assert.ok(parts.every((part) => !parse(part, "extended").some((n) => n.type === "blockQuote")), String(size));
    assert.equal(parse(parts.at(-1), "extended").at(-1).type, "em", String(size));
  }
});

test("random replies never reach the footer, alone or split", () => {
  const atoms = ["a", " ", "\n", "_", "__", "*", "**", "~~", "||", "`", "```", "\\", "> ", ">>> ", "# ", "-# ", "[x](http://y.z)", "http://x.y/a_b", "¯\\_(ツ)_/¯", "word", "\t", "🧠"];
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let n = 0; n < 2000; n += 1) {
    let reply = "";
    for (let i = 0, len = 1 + Math.floor(next() * 25); i < len; i += 1) reply += atoms[Math.floor(next() * atoms.length)];
    const escaped = escapeStrayMarkdown(reply);
    assert.equal(escapeStrayMarkdown(escaped), escaped, JSON.stringify(reply));
    assert.equal(footerNode(reply).type, "em", JSON.stringify(reply));
    const size = 60 + Math.floor(next() * 100);
    const parts = splitMarkdown(`${escaped}\n\n${FOOTER}`, size);
    assert.ok(parts.every((part) => part.length <= size), JSON.stringify(reply));
    assert.equal(parse(parts.at(-1), "extended").at(-1).type, "em", JSON.stringify(reply));
  }
});

test("rewrites a >>> quote as per-line quotes so it ends with the reply", () => {
  assert.equal(escapeStrayMarkdown(">>> big quote\nline two\n\nlast"), "> big quote\n> line two\n> \n> last");
});

test("empty input is safe", () => {
  assert.equal(escapeStrayMarkdown(""), "");
  assert.equal(escapeStrayMarkdown(null), "");
});

test("composes source mappings through nested quotes and trimmed headings", () => {
  for (const [input, expected] of [
    ["> **hello\n> scan_slop world**", "> **hello\n> scan\\_slop world**"],
    ["> **hello\r\n> scan_slop world**", "> **hello\r\n> scan\\_slop world**"],
    ["# \u00a0foo_bar", "# \u00a0foo\\_bar"],
  ]) {
    assert.equal(escapeStrayMarkdown(input), expected);
    assert.equal(escapeStrayMarkdown(expected), expected);
  }
});

test("ambiguous delimiter runs converge without affecting subsequent formatting", () => {
  for (const input of ["_____*b__*", "y_____p__[_ *bold* `code` **x**", " \\¯\\_(ツ)_/¯*a**_`-# **\n¯\\_(ツ)_/¯worda¯\\_(ツ)_/¯```a__**word>>> *a~~"]) {
    const output = escapeStrayMarkdown(input);
    assert.equal(escapeStrayMarkdown(output), output, input);
    assert.equal(footerNode(input).type, "em", input);
    if (input.includes("*bold*")) {
      const nodes = parse(output, "extended");
      assert.ok(nodes.some((node) => node.type === "em"));
      assert.ok(nodes.some((node) => node.type === "inlineCode"));
      assert.ok(nodes.some((node) => node.type === "strong"));
    }
  }
});

test("demoting code escapes its closer and keeps its contents literal", () => {
  const output = escapeStrayMarkdown("`````a_b`> a\n> bword`1. a:b*scan_slop");
  assert.ok(!parse(output, "extended").some((node) => node.type === "inlineCode" || node.type === "codeBlock"));
  assert.equal(escapeStrayMarkdown(output), output);
});

test("notes containing markdown remain inside one italic footer", () => {
  const output = notesFooter(["context 94% — consider `/compress` or `/reset`", "Unexpected token: [_a_ *b* ]", "`foo_bar`"]);
  const nodes = parse(output, "extended");
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].type, "em");
  assert.deepEqual(nodes[0].content.filter((node) => node.type === "inlineCode").map((node) => node.content), ["/compress", "/reset"]);
  assert.equal(notesFooter([]), "");
});

test("bounds parsing work on delimiter runs and long colon words", () => {
  for (const input of ["_".repeat(100_000), "*".repeat(100_000), "a".repeat(100_000) + ":b"]) {
    const started = performance.now();
    escapeStrayMarkdown(input);
    assert.ok(performance.now() - started < 1500, input.slice(0, 20));
  }
});

test("the parser fallback neutralizes quotes after preprocessing whitespace", () => {
  for (const prefix of ["\f>>> ", "\t>>> "]) {
    const input = prefix + "*".repeat(6000);
    assert.equal(footerNode(input).type, "em", JSON.stringify(prefix));
  }
});

test("splits unbroken and nested spans while preserving their styles", () => {
  for (const [input, type] of [
    ["**" + "a".repeat(2000) + "**", "strong"],
    ["`" + "a".repeat(2000) + "`", "inlineCode"],
    ["**" + "a\t".repeat(1000) + "**", "strong"],
    ["**" + "a\r\n".repeat(700) + "**", "strong"],
  ]) {
    const parts = splitMarkdown(input);
    assert.ok(parts.length > 1);
    for (const part of parts) {
      assert.ok(part.length <= 1900);
      assert.equal(parse(part, "extended")[0].type, type, part.slice(0, 30));
    }
  }
  const quote = "> **" + "a".repeat(1000) + "\n> " + "b".repeat(1000) + "**";
  for (const part of splitMarkdown(quote)) {
    const node = parse(part, "extended")[0];
    assert.equal(node.type, "blockQuote");
    assert.equal(node.content[0].type, "strong");
  }
});

test("reopening a container cannot turn literal text into a heading", () => {
  const input = "**" + "a ".repeat(948) + "# title\nend**";
  const parts = splitMarkdown(input);
  const last = parse(parts.at(-1), "extended")[0];
  assert.equal(last.type, "strong");
  assert.ok(!last.content.some((node) => node.type === "heading"));
  assert.ok(last.content.some((node) => node.type === "text" && node.content.includes("#")));
});

test("splits code blocks inside a quote without exposing their contents", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `> const line_${i} = ${i};`);
  const input = "> ```js\n" + lines.join("\n") + "\n> ```";
  const parts = splitMarkdown(input);
  assert.ok(parts.length > 1);
  let code = "";
  for (const part of parts) {
    assert.ok(part.length <= 1900);
    const quote = parse(part, "extended")[0];
    assert.equal(quote.type, "blockQuote");
    assert.equal(quote.content[0].type, "codeBlock");
    assert.equal(quote.content[0].lang, "js");
    code += quote.content[0].content;
  }
  assert.equal(code.replace(/\s/g, ""), lines.map((line) => line.slice(2)).join("").replace(/\s/g, ""));
});

test("mid-line handling recognizes tabs and preserves genuine new lines", () => {
  for (const marker of ["#\t", "-#\t", "#\f# ", "-#\f "]) {
    const parts = splitMarkdown("x".repeat(1899) + " " + marker + "title more");
    assert.ok(!parse(parts.at(-1), "extended").some((node) => node.type === "heading" || node.type === "subtext"));
  }
  const parts = splitMarkdown("a".repeat(1899) + " \n# heading");
  assert.ok(parse(parts.at(-1).trim(), "extended").some((node) => node.type === "heading"));
  for (let pad = 1800; pad < 1950; pad += 1) {
    const chunks = splitMarkdown("x".repeat(pad) + "\n\n" + FOOTER + "\n\n-# from sandbox:ember");
    assert.equal(parse(chunks.at(-1).trim(), "extended").at(-1).type, "subtext", String(pad));
  }
});
