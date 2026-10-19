const TAG_RE = /<\/?compress\s*\/?\s*>/i;

export function extractCompressTag(textIn) {
  const text = String(textIn || "");
  const requested = TAG_RE.test(text);
  const clean = requested
    ? text
        .replace(/<\/?compress\s*\/?\s*>/gi, "")
        .replace(/[ \t]{2,}/g, " ")
        .trim()
    : text.trim();
  return { clean, requested };
}
