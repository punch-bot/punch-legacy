// @ts-nocheck
/**
 * Decide whether Spectrum should start alongside the Discord bot, and start it.
 * Once SPECTRUM_* is in .env, compose/bot bring-up keeps Photon running with Punch.
 */

import {
  loadSpectrumConfig,
  formatConfigError,
  SpectrumConfigError,
  SAFE_STARTUP_ERROR,
} from "./config.js";
import { createSpectrumApp, runSpectrumLoop } from "./app.js";

/**
 * Truthy env helpers: 1/true/yes/on.
 * @param {string | undefined} value
 */
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

/**
 * Whether the bot should auto-start Spectrum.
 * - SPECTRUM_ENABLED=0/false → never
 * - SPECTRUM_ENABLED=1/true → always (then config validation applies)
 * - unset → auto when SPECTRUM_PROJECT_ID + SPECTRUM_PROJECT_SECRET are present
 *   (or PROJECT_ID + PROJECT_SECRET aliases)
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 */
export function shouldStartSpectrum(env = process.env) {
  if (envFlagOff(env.SPECTRUM_ENABLED)) return false;
  if (envFlag(env.SPECTRUM_ENABLED)) return true;
  const id = String(env.SPECTRUM_PROJECT_ID || env.PROJECT_ID || "").trim();
  const secret = String(env.SPECTRUM_PROJECT_SECRET || env.PROJECT_SECRET || "").trim();
  return Boolean(id && secret);
}

/**
 * Start Spectrum in the background on the current process.
 * Does not exit the process on Spectrum failure — logs and returns null.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   createApp?: typeof createSpectrumApp,
 *   runLoop?: typeof runSpectrumLoop,
 *   loadConfig?: typeof loadSpectrumConfig,
 *   log?: (...args: unknown[]) => void,
 *   error?: (...args: unknown[]) => void,
 * }} [deps]
 * @returns {Promise<null | { app: unknown, stop: () => Promise<void> }>}
 */
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

  // Detached loop — Discord owns process lifetime. Spectrum SIGINT handlers are
  // registered by the SDK; bot shutdown should still call stop() when possible.
  const loop = runLoop(app, config).catch((err) => {
    error(`[spectrum] loop ended: ${formatConfigError(err)}`);
  });

  return {
    app,
    async stop() {
      try {
        await app.stop();
      } catch {
        // already stopped
      }
      await loop.catch(() => {});
    },
  };
}
