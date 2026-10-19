import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";

export const TOOL_DIRS = ["/work/.pi/extensions"];

export const MODEL_FILE = "/data/model.json";
export const MODEL_DEFAULT = "opencode/big-pickle";
export const MODEL_ALIASES = {
  "anthropic/claude-sonnet-4-5": MODEL_DEFAULT,
  "poolside/poolside/laguna-xs.2": "poolside/poolside/laguna-xs-2.1",
  "poolside/laguna-xs.2": "poolside/poolside/laguna-xs-2.1",
};

export const DEBOUNCE_MS = 3000;
export const HEALTHY_MS = 8000;

export const WORK = "/work";
export const PROBE_URL = "http://127.0.0.1:4096/health";
export const PI_MODELS_URL = "http://127.0.0.1:4096/models";
export function probeAuth() {
  return (
    "Basic " +
    Buffer.from(
      `${process.env.PI_SERVER_USERNAME || "pi"}:${process.env.PI_SERVER_PASSWORD || ""}`,
    ).toString("base64")
  );
}
export const EXT_DISABLED_FILE = "/data/pi/extensions-disabled.json";

export const ENV_FILE = "/data/env.json";
export const SECRETS_FILE = "/data/secrets.json";
export const AUTH_FILE = join(
  process.env.PI_CODING_AGENT_DIR || "/data/pi/agent",
  "auth.json",
);
export const MODELS_FILE = join(
  process.env.PI_CODING_AGENT_DIR || "/data/pi/agent",
  "models.json",
);
export const MCP_FILE = "/data/mcp.json";
export const PI_MCP_FILE = "/data/pi/agent/mcp.json";

export const API_PORT = 4097;

export const state = {
  child: null,
  startedAt: 0,
  reloadTimer: null,
  restarting: false,
  generation: 0,
  loadedHash: "",
  armedForQuarantine: false,
  CURRENT_MODEL: null,
  THINKING_LEVEL: null,
};

export function log(...a) {
  console.log("[supervisor]", ...a);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function loadJSON(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch { return {}; }
}
export function saveJSON(file, obj) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2));
}
