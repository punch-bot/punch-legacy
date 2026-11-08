import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeCatalog, catalogOptions } from "../src/model-catalog.js";
import { modelsMenuOptions } from "../src/commands/models-menu.js";
import { MODEL_LIST } from "../src/core/config.js";

const payload = {
  providers: ["anthropic", "opencode-go", "pisstral"],
  custom: {
    pisstral: {
      baseUrl: "https://api.mistral.ai/v1",
      api: "openai-completions",
      apiKey: "$PISSTRAL_API_KEY",
      models: [
        { id: "mistral-large-4", name: "le chonk", reasoning: true, contextWindow: 1048576, maxTokens: 262144 },
        { id: "mistral-medium-3.5", name: "Mistral Medium 3.5", contextWindow: 262144, maxTokens: 262144 },
      ],
    },
  },
};

test("normalizeCatalog turns the provider payload into model entries with limits", () => {
  const catalog = normalizeCatalog(payload);
  assert.deepEqual(catalog.names.sort(), ["anthropic", "opencode-go", "pisstral"]);
  const large = catalog.byValue.get("pisstral/mistral-large-4");
  assert.equal(large.contextWindow, 1048576);
  assert.equal(large.label, "le chonk");
  assert.equal(catalog.byValue.get("pisstral/mistral-medium-3.5").contextWindow, 262144);
});

test("normalizeCatalog ignores models without an id and tolerates missing custom blocks", () => {
  const catalog = normalizeCatalog({ providers: ["openai"], custom: { broken: { models: [{ name: "no id" }] } } });
  assert.equal(catalog.models.length, 0);
  assert.equal(catalog.byValue.size, 0);
  assert.deepEqual(normalizeCatalog(null).names, []);
});

test("limits are read from whichever key the provider uses", () => {
  const catalog = normalizeCatalog({
    providers: [],
    custom: {
      opencode: { baseUrl: "https://opencode.ai/inference/go/v1", models: [{ id: "m-go", context: 1000000, max_tokens: 384000 }] },
      openrouter: { baseUrl: "https://openrouter.ai/api/v1", models: [{ id: "big", context_length: 1048576, capabilities: { reasoning: { supported: true } } }] },
      openaiish: { baseUrl: "https://example.test/v1", models: [{ id: "nested", limit: { context: 262144, output: 32768 } }] },
    },
  });
  assert.equal(catalog.byValue.get("opencode/m-go").contextWindow, 1000000);
  assert.equal(catalog.byValue.get("opencode/m-go").maxTokens, 384000);
  assert.equal(catalog.byValue.get("openrouter/big").contextWindow, 1048576);
  assert.equal(catalog.byValue.get("openrouter/big").reasoning, true);
  assert.equal(catalog.byValue.get("openaiish/nested").contextWindow, 262144);
  assert.equal(catalog.byValue.get("openaiish/nested").maxTokens, 32768);
});

test("a catalog model replaces the static entries for its provider", () => {
  const catalog = normalizeCatalog({
    providers: [],
    custom: { poolside: { baseUrl: "https://inference.poolside.ai/v1", models: [{ id: "poolside/laguna-m.1", contextWindow: 262144 }] } },
  });
  const options = modelsMenuOptions(catalogOptions(catalog), () => {});
  assert.ok(options.some((o) => o.value === "poolside/poolside/laguna-m.1"));
  assert.equal(options.filter((o) => o.value.startsWith("poolside/")).length, 1);
});

test("options keep custom providers from overflowing Discord's 25 option limit", () => {
  const catalog = normalizeCatalog({
    providers: [],
    custom: {
      busy: { baseUrl: "https://example.test/v1", models: Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, contextWindow: 1000 })) },
    },
  });
  const truncated = [];
  const options = modelsMenuOptions(catalogOptions(catalog), (msg) => truncated.push(msg));
  assert.equal(options.length, 25);
  assert.ok(truncated.some((m) => m.includes("truncated")), "truncation is logged, not silent");
  assert.equal(options[options.length - 1].value, "__custom__");
  assert.ok(options.some((o) => o.value === "busy/m0"));
});

test("builtin model list survives with no catalog at all", () => {
  const options = modelsMenuOptions([]);
  assert.equal(options.length, MODEL_LIST.length);
});

test("discovery parses an opencode-style models payload", async () => {
  const { parseModelList, discoveryCommand, discoverProviderModels, discoveredModel, clearDiscoveryCache } = await import("../src/model-catalog.js");
  clearDiscoveryCache();
  const cmd = discoveryCommand("opencode-go");
  assert.match(cmd.command, /opencode\.ai\/inference\/go\/v1\/models/);
  assert.match(cmd.command, /\$OPENCODE_API_KEY/);
  const models = parseModelList("opencode-go", {
    object: "list",
    data: [
      { id: "deepseek-v4.1-flash", type: "chat", limit: { context: 1000000, output: 384000 } },
      { id: "text-embedding", type: "embedding" },
    ],
  });
  assert.equal(models.length, 1);
  assert.equal(models[0].contextWindow, 1000000);

  const runner = async () => ({ stdout: JSON.stringify({ data: [{ id: "deepseek-v4.1-flash", limit: { context: 1000000 } }] }) });
  await discoverProviderModels("http://sandbox.test:4097", "opencode-go", { force: true, runner });
  assert.equal(discoveredModel("http://sandbox.test:4097", "opencode-go", "opencode-go/deepseek-v4.1-flash").contextWindow, 1000000);

  const groq = parseModelList("groq", { data: [{ id: "llama3-8b-8192", context_window: 8192 }] });
  assert.equal(groq[0].contextWindow, 8192, "context_window is read like the other spellings");

  let calls = 0;
  const failing = async () => {
    calls += 1;
    return { exitCode: 22, stdout: "" };
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(await discoverProviderModels("http://sandbox.test:4097", "deepseek", { force: true, runner: failing }), null);
    assert.equal(await discoverProviderModels("http://sandbox.test:4097", "deepseek", { runner: failing }), null);
    assert.equal(calls, 1, "a non-zero exit fails, and the failure is cached instead of retried every turn");
  } finally {
    console.error = originalError;
  }
});
