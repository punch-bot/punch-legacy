import { supervisorAuth } from "./core/config.js";

const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map();

function normalizeModel(name, provider, model) {
  const id = String(model?.id || "").trim();
  if (!id) return null;
  const fullId = `${name}/${id}`;
  const contextWindow = Number(
    model?.contextWindow ?? model?.context_length ?? model?.context_window ?? model?.context ?? model?.limit?.context ?? 0,
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

const PROVIDER_MODELS = {
  "opencode-go": { url: "https://opencode.ai/inference/go/v1/models", key: "OPENCODE_API_KEY" },
  openrouter: { url: "https://openrouter.ai/api/v1/models", key: "OPENROUTER_API_KEY" },
  nvidia: { url: "https://integrate.api.nvidia.com/v1/models", key: "NVIDIA_API_KEY" },
  nim: { url: "https://integrate.api.nvidia.com/v1/models", key: "NVIDIA_API_KEY" },
  deepseek: { url: "https://api.deepseek.com/models", key: "DEEPSEEK_API_KEY" },
  groq: { url: "https://api.groq.com/openai/v1/models", key: "GROQ_API_KEY" },
  together: { url: "https://api.together.xyz/v1/models", key: "TOGETHER_API_KEY" },
  openai: { url: "https://api.openai.com/v1/models", key: "OPENAI_API_KEY" },
  poolside: { url: "https://inference.poolside.ai/v1/models", key: "POOLSIDE_API_KEY" },
  mistral: { url: "https://api.mistral.ai/v1/models", key: "MISTRAL_API_KEY" },
};

export function discoverableProviders() {
  return Object.keys(PROVIDER_MODELS);
}

const DISCOVERY_TTL_MS = 30 * 60_000;
const discovery = new Map();
const inflight = new Map();
const runs = new Map();

export function discoveryCommand(provider) {
  const spec = PROVIDER_MODELS[provider];
  if (!spec) return null;
  return {
    command: `curl -sf --max-time 20 ${spec.url} -H "Authorization: Bearer $${spec.key}"`,
    timeout: 30_000,
  };
}

export async function runSandboxCommand(apiUrl, command, timeout = 30_000) {
  const res = await fetch(`${apiUrl}/tasks/exec`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: supervisorAuth(apiUrl) },
    body: JSON.stringify({ command, timeout }),
    signal: AbortSignal.timeout(timeout + 5_000),
  });
  if (!res.ok) throw new Error(`exec ${res.status}`);
  return res.json();
}

export function parseModelList(provider, payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  return rows.filter((row) => row?.type !== "embedding").map((row) => normalizeModel(provider, {}, row)).filter(Boolean);
}

export async function discoverProviderModels(apiUrl, provider, { force = false, runner = runSandboxCommand } = {}) {
  if (!apiUrl || !provider) return null;
  const spec = discoveryCommand(provider);
  if (!spec) {
    console.log(`[catalog] no models endpoint known for provider ${provider}`);
    return null;
  }
  const cacheKey = `${apiUrl}:${provider}`;
  const cached = discovery.get(cacheKey);
  if (!force && cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.models.length ? cached.models : null;
  const pending = inflight.get(cacheKey);
  if (pending && !force) return pending;
  const runId = (runs.get(cacheKey) || 0) + 1;
  runs.set(cacheKey, runId);
  const run = (async () => {
    try {
      const out = await runner(apiUrl, spec.command, spec.timeout);
      if (out?.exitCode !== undefined && out.exitCode !== 0) throw new Error(`exec exit ${out.exitCode}`);
      const models = parseModelList(provider, JSON.parse(out.stdout || "{}"));
      if (!models.length) throw new Error("no models in response");
      if (runs.get(cacheKey) === runId) discovery.set(cacheKey, { at: Date.now(), models });
      return models;
    } catch (err) {
      console.error(`[catalog] discovery failed for ${provider}: ${err.message}`);
      const latest = discovery.get(cacheKey);
      const keep = latest?.models?.length ? latest.models : (cached?.models ?? []);
      if (runs.get(cacheKey) === runId) discovery.set(cacheKey, { at: Date.now(), models: keep });
      return keep.length ? keep : null;
    }
  })();
  inflight.set(cacheKey, run);
  try {
    return await run;
  } finally {
    if (inflight.get(cacheKey) === run) inflight.delete(cacheKey);
  }
}

export function discoveredModel(apiUrl, provider, modelId) {
  const models = discovery.get(`${apiUrl}:${provider}`)?.models;
  if (!models || !modelId) return null;
  const bare = String(modelId).includes("/") ? String(modelId).slice(String(modelId).indexOf("/") + 1) : String(modelId);
  return models.find((m) => m.id === bare || m.value === modelId) || null;
}

export function clearDiscoveryCache() {
  discovery.clear();
}
