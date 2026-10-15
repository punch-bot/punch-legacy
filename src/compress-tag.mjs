const TAG_RE = /<\/?compress\s*\/?\s*>/i;

export function extractCompressTag(textIn) {
  const text = String(textIn || "");
  const requested = TAG_RE.test(text);
  // Only collapse leftover runs of spaces/tabs AROUND THE STRIPPED TAG, and
  // never across lines: \s{2,} here used to eat every newline in the reply
  // (paragraph breaks included) on every message, flattening all of Discord's
  // replies into one-line walls of text. See PNCH-19.
  const clean = requested
    ? text
        .replace(/<\/?compress\s*\/?\s*>/gi, "")
        .replace(/[ \t]{2,}/g, " ")
        .trim()
    : text.trim();
  return { clean, requested };
}
