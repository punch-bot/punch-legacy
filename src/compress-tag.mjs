export function extractCompressTag(textIn) {
  const text = String(textIn || "");
  const requested = /<compress\s*\/?>\s*(?:<\/compress\s*>)?/i.test(text);
  const clean = text.replace(/<compress\s*\/?>\s*(?:<\/compress\s*>)?/gi, "").trim();
  return { clean, requested };
}
