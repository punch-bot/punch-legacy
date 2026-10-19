import {
  loadSpectrumConfig,
  formatConfigError,
  SpectrumConfigError,
  SAFE_STARTUP_ERROR,
} from "./config.js";
import { createSpectrumApp, runSpectrumLoop } from "./app.js";

function envFlag(value) {
  const v = String(value || "")
    .trim()
    .toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function envFlagOff(value) {
  const v = String(value || "")
    .trim()
    .toLowerCase();
  return v === "0" || v === "false" || v === "no" || v === "off";
}

export function shouldStartSpectrum(env = process.env) {
  if (envFlagOff(env.SPECTRUM_ENABLED)) return false;
  if (envFlag(env.SPECTRUM_ENABLED)) return true;
  const id = String(env.SPECTRUM_PROJECT_ID || env.PROJECT_ID || "").trim();
  const secret = String(env.SPECTRUM_PROJECT_SECRET || env.PROJECT_SECRET || "").trim();
  return Boolean(id && secret);
}

export async function startSpectrumAlongsideBot(deps = {}) {
  const env = deps.env || process.env;
  const log = deps.log || console.log.bind(console);
  const error = deps.error || console.error.bind(console);
  const loadConfig = deps.loadConfig || loadSpectrumConfig;
  const createApp = deps.createApp || createSpectrumApp;
  const runLoop = deps.runLoop || runSpectrumLoop;

  if (!shouldStartSpectrum(env)) {
    log("[spectrum] skipped (set SPECTRUM_ENABLED=1 or SPECTRUM_PROJECT_ID/SECRET to enable)");
    return null;
  }

  let config;
  try {
    config = loadConfig(env);
  } catch (err) {
    error(`[spectrum] not started: ${formatConfigError(err)}`);
    return null;
  }

  let app;
  try {
    app = await createApp(config);
  } catch (err) {
    if (err instanceof SpectrumConfigError) {
      error(`[spectrum] not started: ${err.message}`);
    } else {
      error(`[spectrum] not started: ${SAFE_STARTUP_ERROR}`);
    }
    return null;
  }

  log(
    `[spectrum] starting alongside Discord (mode=${config.mode} providers=${config.providers.join(",")})`,
  );

  const loop = runLoop(app, config).catch((err) => {
    error(`[spectrum] loop ended: ${formatConfigError(err)}`);
  });

  return {
    app,
    async stop() {
      try {
        await app.stop();
      } catch {}
      await loop.catch(() => {});
    },
  };
}
