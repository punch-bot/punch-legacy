#!/usr/bin/env node
// @ts-nocheck
/**
 * Punch Spectrum entrypoint — same Pi agent as Discord, via Photon's spectrum-ts.
 *
 *   npm run start:spectrum
 *
 * Does not require DISCORD_TOKEN. Requires Spectrum config in .env (see .env.example).
 * Official docs: https://docs.photon.codes/docs/spectrum-ts/getting-started
 */

import "dotenv/config";
import {
  loadSpectrumConfig,
  formatConfigError,
  SpectrumConfigError,
  SAFE_STARTUP_ERROR,
} from "./spectrum/config.js";
import { createSpectrumApp, runSpectrumLoop } from "./spectrum/app.js";
import { reloadSandboxMap } from "./agent.js";

async function main() {
  let config;
  try {
    config = loadSpectrumConfig(process.env);
  } catch (err) {
    console.error(`[spectrum] configuration error: ${formatConfigError(err)}`);
    process.exit(1);
  }

  reloadSandboxMap();

  let app;
  try {
    app = await createSpectrumApp(config);
  } catch (err) {
    if (err instanceof SpectrumConfigError) {
      console.error(`[spectrum] configuration error: ${err.message}`);
    } else {
      // Do not print SDK err.message — it may include request options or secrets.
      console.error(`[spectrum] ${SAFE_STARTUP_ERROR}`);
      console.error(
        "[spectrum] Check SPECTRUM_PROJECT_ID / SPECTRUM_PROJECT_SECRET and that the imessage platform is enabled in https://app.photon.codes/",
      );
    }
    process.exit(1);
  }

  console.log("[spectrum] Punch Spectrum entrypoint online");
  try {
    await runSpectrumLoop(app, config);
  } finally {
    try {
      await app.stop();
    } catch {
      // SDK may already have stopped on signal.
    }
  }
}

main().catch((err) => {
  console.error(`[spectrum] fatal: ${formatConfigError(err)}`);
  process.exit(1);
});
