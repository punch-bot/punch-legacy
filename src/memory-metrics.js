// Log sizes only: queries, facts, user identities, and recalled text stay private.
export function logMemorySize(source, text) {
  const chars = text.length;
  console.log(`[memory] ${source} chars=${chars} approxTokens=${chars / 4}`);
}
