// Check a `provider/model` slug against Pi's get_available_models before the
// supervisor saves it. Pi lists only models whose provider has a key, and its
// set_model takes the model id literally, so "claude-opus-5-5" is not
// "claude-opus-5.5". A bad slug used to be saved anyway. Pi then fell back to
// another model and nothing was reported.

/** `provider/model` → { provider, modelId }; the model id may contain slashes. */
export function splitModelSlug(slug) {
  const s = String(slug || "").trim();
  const i = s.indexOf("/");
  if (i <= 0 || i === s.length - 1) return null;
  return { provider: s.slice(0, i), modelId: s.slice(i + 1) };
}

// Case and punctuation ignored: "claude-opus-5-5" ~ "Claude-Opus-5.5". Suffixes
// such as ":free" or ":nitro" still differ, so OpenRouter variants never match.
function looseKey(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Same-provider ids that differ from `modelId` only in case or punctuation.
 * Shown as hints only; the check itself is exact and never picks one.
 */
export function suggestModels(provider, modelId, models) {
  const want = looseKey(modelId);
  if (!want) return [];
  return models
    .filter((m) => m.provider === provider && looseKey(m.id) === want)
    .map((m) => `${m.provider}/${m.id}`);
}

/**
 * Resolve `slug` against Pi's available models ({ provider, id }[]).
 * Returns { ok: true, provider, modelId } or { ok: false, error, suggestions }.
 */
export function checkModel(slug, models) {
  const parsed = splitModelSlug(slug);
  if (!parsed) {
    return {
      ok: false,
      error: `\`${slug}\` isn't a model. Use \`provider/model\`, e.g. \`openrouter/anthropic/claude-opus-5.5\`.`,
      suggestions: [],
    };
  }
  const { provider, modelId } = parsed;
  const list = Array.isArray(models) ? models : [];
  if (list.some((m) => m.provider === provider && m.id === modelId)) {
    return { ok: true, provider, modelId };
  }
  const suggestions = suggestModels(provider, modelId, list);
  const error = list.some((m) => m.provider === provider)
    ? `Pi has no model \`${modelId}\` for provider \`${provider}\`.`
    : `Pi has no models for provider \`${provider}\`. Set its key with \`/apikey provider:${provider} key:<key>\`, or check the provider name.`;
  return { ok: false, error, suggestions };
}

/** One-line error for Discord, with suggestions when there are any. */
export function formatModelCheckError({ error, suggestions }) {
  if (!suggestions?.length) return error;
  return `${error} Did you mean ${suggestions.map((s) => `\`${s}\``).join(", ")}?`;
}
