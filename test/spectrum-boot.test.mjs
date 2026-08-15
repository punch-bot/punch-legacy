import test from "node:test";
import assert from "node:assert/strict";
import { shouldStartSpectrum, startSpectrumAlongsideBot } from "../src/spectrum/boot.js";
import { SpectrumConfigError } from "../src/spectrum/config.js";

test("shouldStartSpectrum is off when SPECTRUM_ENABLED=0", () => {
  assert.equal(
    shouldStartSpectrum({
      SPECTRUM_ENABLED: "0",
      SPECTRUM_PROJECT_ID: "p",
      SPECTRUM_PROJECT_SECRET: "s",
    }),
    false,
  );
});

test("shouldStartSpectrum is on when SPECTRUM_ENABLED=1", () => {
  assert.equal(shouldStartSpectrum({ SPECTRUM_ENABLED: "1" }), true);
});

test("shouldStartSpectrum auto-enables when project credentials are present", () => {
  assert.equal(
    shouldStartSpectrum({
      SPECTRUM_PROJECT_ID: "proj",
      SPECTRUM_PROJECT_SECRET: "sec",
    }),
    true,
  );
  assert.equal(shouldStartSpectrum({ SPECTRUM_PROJECT_ID: "proj" }), false);
  assert.equal(shouldStartSpectrum({}), false);
});

test("startSpectrumAlongsideBot skips when disabled", async () => {
  const logs = [];
  const result = await startSpectrumAlongsideBot({
    env: { SPECTRUM_ENABLED: "0" },
    log: (...a) => logs.push(a.join(" ")),
    error: () => {},
  });
  assert.equal(result, null);
  assert.match(logs.join("\n"), /skipped/);
});

test("startSpectrumAlongsideBot reports config errors without throwing", async () => {
  const errors = [];
  const result = await startSpectrumAlongsideBot({
    env: {
      SPECTRUM_ENABLED: "1",
      SPECTRUM_MODE: "agent",
      SPECTRUM_PROVIDERS: "imessage",
    },
    log: () => {},
    error: (...a) => errors.push(a.join(" ")),
  });
  assert.equal(result, null);
  assert.match(errors.join("\n"), /not started/);
});

test("startSpectrumAlongsideBot runs loop when createApp succeeds", async () => {
  const calls = [];
  const app = {
    async stop() {
      calls.push("stop");
    },
  };
  const handle = await startSpectrumAlongsideBot({
    env: {
      SPECTRUM_ENABLED: "1",
      SPECTRUM_MODE: "echo",
      SPECTRUM_PROVIDERS: "terminal",
    },
    log: () => {},
    error: () => {},
    loadConfig: () => ({
      mode: "echo",
      providers: ["terminal"],
      hasProjectCredentials: false,
      userMap: {},
    }),
    createApp: async () => app,
    runLoop: async () => {
      calls.push("loop");
    },
  });
  assert.ok(handle);
  assert.equal(handle.app, app);
  await handle.stop();
  assert.ok(calls.includes("loop"));
  assert.ok(calls.includes("stop"));
});

test("startSpectrumAlongsideBot swallows SpectrumConfigError from createApp", async () => {
  const errors = [];
  const result = await startSpectrumAlongsideBot({
    env: { SPECTRUM_ENABLED: "1", SPECTRUM_MODE: "echo", SPECTRUM_PROVIDERS: "terminal" },
    log: () => {},
    error: (...a) => errors.push(a.join(" ")),
    loadConfig: () => ({ mode: "echo", providers: ["terminal"], userMap: {}, hasProjectCredentials: false }),
    createApp: async () => {
      throw new SpectrumConfigError("boom");
    },
  });
  assert.equal(result, null);
  assert.match(errors.join("\n"), /boom/);
});
