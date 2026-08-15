import test from "node:test";
import assert from "node:assert/strict";
import { buildProviderConfigs, buildSpectrumOptions } from "../src/spectrum/providers.js";
import { extractInboundText } from "../src/spectrum/app.js";
import { loadSpectrumConfig } from "../src/spectrum/config.js";
import { stripDiscordMarkup } from "../src/punch-turn.js";

test("buildProviderConfigs calls imessage.config and terminal.config", () => {
  const calls = [];
  const imessage = {
    config(opts) {
      calls.push(["imessage", opts]);
      return { platform: "imessage" };
    },
  };
  const terminal = {
    config(opts) {
      calls.push(["terminal", opts]);
      return { platform: "terminal" };
    },
  };
  const providers = buildProviderConfigs(["imessage", "terminal"], { imessage, terminal });
  assert.deepEqual(
    providers.map((p) => p.platform),
    ["imessage", "terminal"],
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], "imessage");
  assert.equal(calls[1][0], "terminal");
});

test("buildProviderConfigs rejects unknown provider", () => {
  assert.throws(
    () => buildProviderConfigs(["whatsapp"], { imessage: { config() {} }, terminal: { config() {} } }),
    /Unknown Spectrum provider/,
  );
});

test("buildSpectrumOptions includes credentials only when both set", () => {
  const withCreds = buildSpectrumOptions({
    providers: [{ platform: "imessage" }],
    projectId: "p",
    projectSecret: "s",
  });
  assert.equal(withCreds.projectId, "p");
  assert.equal(withCreds.projectSecret, "s");

  const without = buildSpectrumOptions({
    providers: [{ platform: "terminal" }],
  });
  assert.equal("projectId" in without, false);
  assert.equal("projectSecret" in without, false);
});

test("createSpectrumApp-compatible options from loadSpectrumConfig", () => {
  const cfg = loadSpectrumConfig({
    SPECTRUM_MODE: "agent",
    SPECTRUM_PROVIDERS: "imessage,terminal",
    SPECTRUM_PROJECT_ID: "proj",
    SPECTRUM_PROJECT_SECRET: "sec",
    SPECTRUM_USER_MAP: '{"+1":"1"}',
    SPECTRUM_DEFAULT_USER_ID: "1",
  });
  const imessage = { config: () => ({ id: "imessage" }) };
  const terminal = { config: () => ({ id: "terminal" }) };
  const providers = buildProviderConfigs(cfg.providers, { imessage, terminal });
  const options = buildSpectrumOptions({
    providers,
    projectId: cfg.projectId,
    projectSecret: cfg.projectSecret,
  });
  assert.equal(options.providers.length, 2);
  assert.equal(options.projectId, "proj");
  assert.equal(options.projectSecret, "sec");
});

test("extractInboundText reads text and markdown content", () => {
  assert.equal(extractInboundText({ type: "text", text: " hi " }), "hi");
  assert.equal(extractInboundText({ type: "markdown", markdown: "**x**" }), "**x**");
  assert.equal(extractInboundText({ type: "attachment" }), "");
});

test("stripDiscordMarkup removes react/embed tags", () => {
  const cleaned = stripDiscordMarkup(
    'Hello <react emoji="👍"></react> world <embed>{"title":"t"}</embed>',
  );
  assert.equal(cleaned, "Hello  world");
});
