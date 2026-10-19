export function splitModelSlug(slug) {
  const s = String(slug || "").trim();
  const i = s.indexOf("/");
  if (i <= 0 || i === s.length - 1) return null;
  return { provider: s.slice(0, i), modelId: s.slice(i + 1) };
}

function looseKey(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function suggestModels(provider, modelId, models) {
  const want = looseKey(modelId);
  if (!want) return [];
  return models
    .filter((m) => m.provider === provider && looseKey(m.id) === want)
    .map((m) => `${m.provider}/${m.id}`);
}

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

export function formatModelCheckError({ error, suggestions }) {
  if (!suggestions?.length) return error;
  return `${error} Did you mean ${suggestions.map((s) => `\`${s}\``).join(", ")}?`;
}
