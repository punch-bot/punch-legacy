// Shared by legacy import, SQLite indexing, and memory ranking.
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "how",
  "i", "in", "is", "it", "me", "my", "of", "on", "or", "that", "the", "this", "to",
  "was", "what", "when", "where", "which", "who", "with", "you", "your",
]);

export const MEMORY_PREAMBLE_MAX_CHARS = 4_000;

export function cleanLine(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

export function normalize(text) {
  return cleanLine(text).normalize("NFKC").toLowerCase()
    .replace(/["'`\u201c\u201d\u2018\u2019\u2022\u2013\u2014]/g, " ")
    .replace(/\s+/g, " ").trim();
}

export function terms(text) {
  const words = String(text || "").normalize("NFKC").toLowerCase()
    .match(/[\p{L}\p{N}][\p{L}\p{N}_+#.-]*/gu) || [];
  return [...new Set(words.map((word) => word.replace(/\.+$/, ""))
    .filter((word) => (word.length >= 3 || /[+#]/.test(word)) && !STOP_WORDS.has(word)))];
}

export function matchesTerm(word, term) {
  return word === term || (/^[\p{L}\p{N}]{3,}$/u.test(term) && word.startsWith(term));
}

export function ftsQuery(queryTerms) {
  return queryTerms.map((term) => `"${term.replaceAll('"', '""')}"${/^[\p{L}\p{N}]{3,}$/u.test(term) ? "*" : ""}`).join(" OR ");
}
