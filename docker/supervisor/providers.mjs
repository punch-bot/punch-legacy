// Model / API-key / provider routes for the sandbox supervisor.
import { ENV_FILE, log, saveJSON, state } from "./state.mjs";
import { forceRestart } from "./gateway.mjs";
import {
  PROVIDER_ENV_MAP,
  mirrorGoogleGemini,
  normalizeModel,
  saveModel,
  syncAuthProvider,
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
  const models = (() => {
    try {
      return JSON.parse(
        require("node:fs").readFileSync(require("node:path").join(
          process.env.PI_CODING_AGENT_DIR || "/data/pi/agent",
          "models.json",
        ), "utf8"),
      );
    } catch {
      return {};
    }
  })();

  if (req.method === "GET" && url.pathname === "/model") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: state.CURRENT_MODEL }));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/model") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { model } = JSON.parse(body);
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

  if (req.method === "GET" && url.pathname === "/apikeys") {
    const env = require("node:fs").existsSync(ENV_FILE)
      ? JSON.parse(require("node:fs").readFileSync(ENV_FILE, "utf8"))
      : {};
    const configured = [];
    for (const key of Object.keys(env)) {
      if (Object.values(PROVIDER_ENV_MAP).includes(key)) {
        configured.push(key);
      } else if (key.endsWith("_API_KEY")) {
        configured.push(key);
      }
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ providers: configured }));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/apikey") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { provider, key } = JSON.parse(body);
        const id = sanitizeId(provider);
        const envVar = PROVIDER_ENV_MAP[id] || `${String(provider || "").toUpperCase().replace(/[^A-Z0-9_]/g, "")}_API_KEY`;
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
        syncAuthProvider(provider, key ? String(key).trim() : null);
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
    const providers = { ...PROVIDER_ENV_MAP };
    for (const name of Object.keys(models.providers || {})) {
      if (!(name in providers)) providers[name] = `$${name.toUpperCase()}_API_KEY`;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ providers, custom: models.providers || {} }));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/provider") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { name, endpoint, api } = JSON.parse(body);
        const id = sanitizeId(name);
        if (!id || !endpoint) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Missing name or endpoint" }));
          return;
        }
        const prev = models.providers?.[id] || {};
        models.providers = models.providers || {};
        models.providers[id] = {
          ...prev,
          baseUrl: endpoint,
          api: api || prev.api || "openai-completions",
          apiKey: prev.apiKey || `$${id.toUpperCase()}_API_KEY`,
        };
        require("node:fs").writeFileSync(require("node:path").join(
          process.env.PI_CODING_AGENT_DIR || "/data/pi/agent",
          "models.json",
        ), JSON.stringify(models, null, 2));
        forceRestart();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true, id }));
        log(`provider ${key ? "set" : "removed"}: ${id}`);
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
        const id = sanitizeId(name);
        if (!models.providers?.[id]) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Provider not found" }));
          return;
        }
        delete models.providers[id];
        require("node:fs").writeFileSync(require("node:path").join(
          process.env.PI_CODING_AGENT_DIR || "/data/pi/agent",
          "models.json",
        ), JSON.stringify(models, null, 2));
        forceRestart();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true }));
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
        if (existing >= 0) models.providers[pid].models[existing] = entry;
        else models.providers[pid].models.push(entry);
        require("node:fs").writeFileSync(require("node:path").join(
          process.env.PI_CODING_AGENT_DIR || "/data/pi/agent",
          "models.json",
        ), JSON.stringify(models, null, 2));
        forceRestart();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true }));
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
        const pid = sanitizeId(provider);
        const list = models.providers?.[pid]?.models || [];
        const idx = list.findIndex((m) => m.id === model);
        if (!pid || idx < 0) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Provider or model not found" }));
          return;
        }
        list.splice(idx, 1);
        require("node:fs").writeFileSync(require("node:path").join(
          process.env.PI_CODING_AGENT_DIR || "/data/pi/agent",
          "models.json",
        ), JSON.stringify(models, null, 2));
        forceRestart();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return true;
  }

  return false;
}
