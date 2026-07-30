const TAG_RE = /<\/?compress\s*\/?\s*>/i;

export function extractCompressTag(textIn) {
  const text = String(textIn || "");
  const requested = TAG_RE.test(text);
  const clean = text.replace(/<\/?compress\s*\/?\s*>/gi, "").replace(/\s{2,}/g, " ").trim();
  return { clean, requested };
}
