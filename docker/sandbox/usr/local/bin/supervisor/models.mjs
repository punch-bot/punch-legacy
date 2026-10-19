import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizeThinkingLevel } from "/usr/local/lib/pi-thinking-level.mjs";
import { AUTH_FILE, ENV_FILE, MODEL_ALIASES, MODEL_DEFAULT, MODEL_FILE, MODELS_FILE, log, loadJSON, saveJSON } from "./state.mjs";

export function normalizeModel(model) {
  const s = String(model || "").trim();
  if (!s) return MODEL_DEFAULT;
  return MODEL_ALIASES[s] || s;
}

export function loadModel() {
  try { const v = JSON.parse(readFileSync(MODEL_FILE, "utf8")).model; return v || null; }
  catch { return null; }
}
export function loadThinkingLevel() {
  return normalizeThinkingLevel(loadJSON(MODEL_FILE).thinkingLevel);
}
function updateModelFile(patch) {
  writeFileSync(MODEL_FILE, JSON.stringify({ ...loadJSON(MODEL_FILE), ...patch }));
}
export function saveModel(model) {
  updateModelFile({ model });
}
export function saveThinkingLevel(thinkingLevel) {
  updateModelFile({ thinkingLevel });
}

export const BUILTIN_CUSTOM_PROVIDERS = {
  poolside: {
    baseUrl: "https://inference.poolside.ai/v1",
    api: "openai-completions",
    apiKey: "$POOLSIDE_API_KEY",
    models: [
      {
        id: "poolside/laguna-m.1",
        name: "Laguna M.1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 32768,
      },
      {
        id: "poolside/laguna-xs-2.1",
        name: "Laguna XS 2.1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 32768,
      },
      {
        id: "poolside/laguna-s-2.1",
        name: "Laguna S 2.1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 32768,
      },
      {
        id: "poolside/laguna-xs.2",
        name: "Laguna XS (legacy id)",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 32768,
      },
    ],
  },
};

export function ensurePiModelsJson() {
  mkdirSync(dirname(MODELS_FILE), { recursive: true });
  const existing = loadJSON(MODELS_FILE);
  if (!existing.providers || typeof existing.providers !== "object") {
    existing.providers = {};
  }
  let changed = false;
  for (const [id, cfg] of Object.entries(BUILTIN_CUSTOM_PROVIDERS)) {
    const prev = existing.providers[id];
    const next = { ...cfg };
    if (prev?.baseUrl && prev.baseUrl !== cfg.baseUrl) next.baseUrl = prev.baseUrl;
    if (Array.isArray(prev?.models) && prev.models.length) {
      const byId = new Map(cfg.models.map((m) => [m.id, { ...m }]));
      for (const m of prev.models) {
        if (m?.id) byId.set(m.id, { ...(byId.get(m.id) || {}), ...m });
      }
      next.models = [...byId.values()];
    }
    const same = JSON.stringify(prev) === JSON.stringify(next);
    if (!same) {
      existing.providers[id] = next;
      changed = true;
    }
  }
  if (changed || !existsSync(MODELS_FILE)) {
    saveJSON(MODELS_FILE, existing);
    log("ensured Pi models.json custom providers:", Object.keys(BUILTIN_CUSTOM_PROVIDERS).join(", "));
  }
}

export const PROVIDER_ENV_MAP = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  google: "GOOGLE_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  groq: "GROQ_API_KEY",
  together: "TOGETHER_API_KEY",
  poolside: "POOLSIDE_API_KEY",
  opencode: "OPENCODE_API_KEY",
  "opencode-go": "OPENCODE_API_KEY",
  nvidia: "NVIDIA_API_KEY",
};

export const RESERVED_PROVIDER_IDS = new Set(["__proto__", "constructor", "prototype"]);

export function sanitizeProviderId(provider) {
  const id = String(provider || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!id || RESERVED_PROVIDER_IDS.has(id)) return null;
  return id;
}

export function syncAuthProvider(provider, key) {
  const id = sanitizeProviderId(provider);
  if (!id) {
    log(`syncAuthProvider: rejected invalid provider id: ${provider}`);
    return;
  }
  const auth = loadJSON(AUTH_FILE);
  if (key) {
    auth[id] = { type: "api_key", key };
  } else {
    delete auth[id];
  }
  saveJSON(AUTH_FILE, auth);
}

export function mirrorGoogleGemini(env, key) {
  if (key) {
    env.GEMINI_API_KEY = key;
    process.env.GEMINI_API_KEY = key;
  } else {
    delete env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
  }
}

export function syncEnvApiKeysToAuth() {
  const env = loadJSON(ENV_FILE);
  const auth = loadJSON(AUTH_FILE);
  let changed = false;
  for (const [provider, envVar] of Object.entries(PROVIDER_ENV_MAP)) {
    let key = env[envVar];
    if (provider === "google" && !key) key = env.GEMINI_API_KEY;
    if (key && (auth[provider]?.key !== key || auth[provider]?.type !== "api_key")) {
      auth[provider] = { type: "api_key", key };
      changed = true;
    } else if (!key && auth[provider]) {
      delete auth[provider];
      changed = true;
    }
  }
  if (env.GOOGLE_API_KEY && env.GEMINI_API_KEY !== env.GOOGLE_API_KEY) {
    env.GEMINI_API_KEY = env.GOOGLE_API_KEY;
    process.env.GEMINI_API_KEY = env.GOOGLE_API_KEY;
    saveJSON(ENV_FILE, env);
  }
  if (changed) {
    saveJSON(AUTH_FILE, auth);
    log("synced API keys from env.json -> auth.json");
  }
}
