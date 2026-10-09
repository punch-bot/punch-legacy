// Model / API-key / provider routes for the sandbox supervisor.
import { readFileSync } from "node:fs";
import {
  PINNED_PROVIDER,
  modelsJsonEntry,
  withRegisteredModel,
} from "/usr/local/lib/pi-model-pin.mjs";
import { normalizeThinkingLevel } from "/usr/local/lib/pi-thinking-level.mjs";
import { AUTH_FILE, ENV_FILE, MODELS_FILE, loadJSON, log, saveJSON, state } from "./state.mjs";
import { forceRestart } from "./gateway.mjs";
import {
  PROVIDER_ENV_MAP,
  mirrorGoogleGemini,
  normalizeModel,
  saveModel,
  saveThinkingLevel,
  syncAuthProvider,
  RESERVED_PROVIDER_IDS,
} from "./models.mjs";

function sanitizeId(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function titlecase(s) {
  return String(s || "")
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Model, API-key and custom-provider routes. Returns true if handled. */
export function handleProviderRoutes(req, res, url) {
  if (req.method === "GET" && url.pathname === "/model") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: state.CURRENT_MODEL, thinkingLevel: state.THINKING_LEVEL }));
    return true;
  }

  // Reasoning level applied to every turn's model (see pi-thinking-level.mjs).
  // null / "default" clears it. No forceRestart: the gateway applies it per turn.
  if (req.method === "POST" && url.pathname === "/model/thinking") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const reply = (status, payload) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      try {
        const { level } = JSON.parse(body);
        const raw = String(level ?? "").trim().toLowerCase();
        const thinkingLevel = normalizeThinkingLevel(raw);
        if (raw && raw !== "default" && !thinkingLevel) {
          reply(400, { error: `Unknown reasoning level: ${level}` });
          return;
        }
        state.THINKING_LEVEL = thinkingLevel;
        saveThinkingLevel(thinkingLevel);
        reply(200, { success: true, thinkingLevel });
        log(`reasoning level: ${thinkingLevel || "default"}`);
      } catch {
        reply(400, { error: "Invalid JSON" });
      }
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/model") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { model } = JSON.parse(body);
        if (!model) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Missing model" }));
          return;
        }
        const normalized = normalizeModel(model);
        state.CURRENT_MODEL = normalized;
        process.env.PI_DEFAULT_MODEL = normalized;
        process.env.PI_MODEL = normalized;
        saveModel(normalized);
        forceRestart();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true, model: normalized }));
        log(`model changed to: ${normalized}`);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return true;
  }

  // Gateway-only (see pi-model-pin.mjs): add a bare OpenRouter id Pi's catalog
  // lacks so `--model` matches it exactly. Lives here so the supervisor stays
  // the only models.json writer. No forceRestart: the gateway relaunches Pi.
  if (req.method === "POST" && url.pathname === "/model/register") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const reply = (status, payload) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      try {
        const { provider, entry } = JSON.parse(body);
        if (provider !== PINNED_PROVIDER || typeof entry?.id !== "string" || !entry.id) {
          reply(400, { error: "Invalid provider or model" });
          return;
        }
        let config = {};
        try {
          config = JSON.parse(readFileSync(MODELS_FILE, "utf8"));
        } catch (e) {
          // Unlike loadJSON, never treat an unreadable file as empty and overwrite it.
          if (e.code !== "ENOENT") {
            reply(409, { error: `models.json unreadable: ${e.message}` });
            return;
          }
        }
        const next = withRegisteredModel(config, provider, modelsJsonEntry(entry, entry.id));
        if (next) {
          saveJSON(MODELS_FILE, next);
          log(`model registered for pin: ${provider}/${entry.id}`);
        }
        reply(200, { registered: Boolean(next) });
      } catch (e) {
        reply(400, { error: e.message });
      }
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/apikeys") {
    const env = loadJSON(ENV_FILE);
    const auth = loadJSON(AUTH_FILE);
    const configured = [];
    // Prefer exact provider ids from auth.json (custom ids may contain dashes,
    // which an env-var-derived name cannot recover).
    for (const [provider, entry] of Object.entries(auth)) {
      if (entry?.type === "api_key" && entry?.key) configured.push(provider);
    }
    // also include any _API_KEY env vars for custom providers not tracked in auth
    const authEnvVars = new Set(
      configured.map((p) => `${p.toUpperCase().replace(/-/g, "_")}_API_KEY`),
    );
    for (const k of Object.keys(env)) {
      if (k.endsWith("_API_KEY") && !authEnvVars.has(k)) {
        configured.push(k.replace("_API_KEY", "").toLowerCase());
      }
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ providers: [...new Set(configured)] }));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/apikey") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { provider, key } = JSON.parse(body);
        if (!provider) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Missing provider" }));
          return;
        }
        const id = sanitizeId(provider);
        if (!id || RESERVED_PROVIDER_IDS.has(id)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid provider" }));
          return;
        }
        const envVar = PROVIDER_ENV_MAP[id] || `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
        const env = loadJSON(ENV_FILE);
        if (key) {
          env[envVar] = String(key).trim();
          process.env[envVar] = String(key).trim();
          if (id === "google") mirrorGoogleGemini(env, String(key).trim());
        } else {
          delete env[envVar];
          delete process.env[envVar];
          if (id === "google") mirrorGoogleGemini(env, null);
        }
        saveJSON(ENV_FILE, env);
        const trimmedKey = key ? String(key).trim() : null;
        syncAuthProvider(provider, trimmedKey);
        // Keep sibling providers sharing this env var in sync (e.g. opencode
        // and opencode-go both use OPENCODE_API_KEY).
        for (const [pid, ev] of Object.entries(PROVIDER_ENV_MAP)) {
          if (ev === envVar && pid !== id) syncAuthProvider(pid, trimmedKey);
        }
        forceRestart();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true }));
        log(`apikey ${key ? "set" : "removed"} for: ${provider}`);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/providers") {
    const modelProviders = loadJSON(MODELS_FILE).providers || {};
    const builtinProviders = Object.keys(PROVIDER_ENV_MAP);
    const allProviders = [...new Set([...builtinProviders, ...Object.keys(modelProviders)])];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ providers: allProviders, custom: modelProviders }));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/provider") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { name, endpoint, api } = JSON.parse(body);
        const models = loadJSON(MODELS_FILE);
        if (!name) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Missing name" }));
          return;
        }
        const id = sanitizeId(name);
        if (!id || RESERVED_PROVIDER_IDS.has(id)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid provider name" }));
          return;
        }
        const prev = models.providers?.[id] || {};
        models.providers = models.providers || {};
        models.providers[id] = {
          ...prev,
          baseUrl: endpoint || prev.baseUrl || "",
          api: api || prev.api || "openai-completions",
          apiKey: prev.apiKey || `$${id.toUpperCase().replace(/-/g, "_")}_API_KEY`,
          models: prev.models || [],
        };
        saveJSON(MODELS_FILE, models);
        forceRestart();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true, provider: id, baseUrl: models.providers[id].baseUrl }));
        log(`provider ${prev.baseUrl ? "updated" : "created"}: ${id}`);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return true;
  }

  if (req.method === "DELETE" && url.pathname === "/provider") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { name } = JSON.parse(body);
        const models = loadJSON(MODELS_FILE);
        const id = sanitizeId(name);
        if (!id || RESERVED_PROVIDER_IDS.has(id)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid provider name" }));
          return;
        }
        if (!models.providers?.[id]) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Provider not found" }));
          return;
        }
        delete models.providers[id];
        saveJSON(MODELS_FILE, models);
        forceRestart();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true }));
        log(`provider removed: ${id}`);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/provider/model") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { provider, model, name, context, maxTokens, reasoning } = JSON.parse(body);
        const models = loadJSON(MODELS_FILE);
        const pid = sanitizeId(provider);
        if (!pid || !model) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Missing provider or model" }));
          return;
        }
        if (!models.providers?.[pid]) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Provider not found" }));
          return;
        }
        const entry = {
          id: model,
          name: name || titlecase(String(model).replace(/[-_]/g, " ")),
          reasoning: reasoning === true || reasoning === "true" || reasoning === "yes",
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: parseInt(context, 10) || 128000,
          maxTokens: parseInt(maxTokens, 10) || 4096,
        };
        models.providers[pid].models = models.providers[pid].models || [];
        const existing = models.providers[pid].models.findIndex((m) => m.id === model);
        if (existing >= 0) models.providers[pid].models[existing] = { ...models.providers[pid].models[existing], ...entry };
        else models.providers[pid].models.push(entry);
        saveJSON(MODELS_FILE, models);
        forceRestart();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true, model }));
        log(`model ${existing >= 0 ? "updated" : "added"}: ${pid}/${model}`);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return true;
  }

  if (req.method === "DELETE" && url.pathname === "/provider/model") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { provider, model } = JSON.parse(body);
        const models = loadJSON(MODELS_FILE);
        const pid = sanitizeId(provider);
        if (!pid || !model) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Missing provider or model" }));
          return;
        }
        const list = models.providers?.[pid]?.models || [];
        const idx = list.findIndex((m) => m.id === model);
        if (idx < 0) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Model not found" }));
          return;
        }
        list.splice(idx, 1);
        saveJSON(MODELS_FILE, models);
        forceRestart();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true }));
        log(`model removed: ${pid}/${model}`);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return true;
  }

  return false;
}
