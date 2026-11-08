import { supervisorAuth } from "./core/config.js";

const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map();

function normalizeModel(name, provider, model) {
  const id = String(model?.id || "").trim();
  if (!id) return null;
  const fullId = `${name}/${id}`;
  const contextWindow = Number(
    model?.contextWindow ?? model?.context_length ?? model?.context ?? model?.limit?.context ?? 0,
  ) || 0;
  return {
    provider: name,
    id,
    value: fullId,
    label: String(model?.name || id),
    contextWindow,
    maxTokens: Number(model?.maxTokens ?? model?.max_tokens ?? model?.limit?.output ?? 0) || 0,
    reasoning: Boolean(model?.reasoning ?? model?.capabilities?.reasoning?.supported),
    input: Array.isArray(model?.input) ? model.input : ["text"],
    remote: Boolean(provider?.baseUrl),
  };
}

export function normalizeCatalog(payload) {
  const names = Array.isArray(payload?.providers) ? payload.providers.map(String) : [];
  const custom = payload?.custom && typeof payload.custom === "object" ? payload.custom : {};
  const models = [];
  for (const [name, provider] of Object.entries(custom)) {
    for (const entry of provider?.models || []) {
      const model = normalizeModel(name, provider, entry);
      if (model) models.push(model);
    }
  }
  const byValue = new Map(models.map((m) => [m.value, m]));
  return { names: [...new Set([...names, ...Object.keys(custom)])], models, byValue };
}

export async function loadCatalog(apiUrl, { force = false } = {}) {
  if (!apiUrl) return null;
  const cached = cache.get(apiUrl);
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.catalog;
  try {
    const res = await fetch(`${apiUrl}/providers`, {
      headers: { authorization: supervisorAuth(apiUrl) },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`supervisor API ${res.status}`);
    const catalog = normalizeCatalog(await res.json());
    cache.set(apiUrl, { at: Date.now(), catalog });
    return catalog;
  } catch (err) {
    if (cached) return cached.catalog;
    console.error(`[catalog] failed to load providers from ${apiUrl}: ${err.message}`);
    return null;
  }
}

export function catalogModel(apiUrl, model) {
  const catalog = cache.get(apiUrl)?.catalog;
  if (!catalog || !model) return null;
  return catalog.byValue.get(model) || null;
}

export function catalogModelNames(apiUrl) {
  const catalog = cache.get(apiUrl)?.catalog;
  return catalog ? catalog.names : [];
}

export function catalogOptions(catalog) {
  if (!catalog) return [];
  return catalog.models.map((m) => ({
      label: `${m.label} (${m.provider})`.slice(0, 100),
      value: m.value,
    description: m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k context` : undefined,
  }));
}

export function clearCatalogCache() {
  cache.clear();
}
