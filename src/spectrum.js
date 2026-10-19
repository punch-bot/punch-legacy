#!/usr/bin/env node
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
    } catch {}
  }
}

main().catch((err) => {
  console.error(`[spectrum] fatal: ${formatConfigError(err)}`);
  process.exit(1);
});
