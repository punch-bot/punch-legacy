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

test("options keep custom providers from overflowing Discord's 25 option limit", () => {
  const catalog = normalizeCatalog({
    providers: [],
    custom: {
      busy: { baseUrl: "https://example.test/v1", models: Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, contextWindow: 1000 })) },
    },
  });
  const options = modelsMenuOptions(catalogOptions(catalog));
  assert.equal(options.length, 25);
  assert.equal(options[options.length - 1].value, "__custom__");
  assert.ok(options.some((o) => o.value === "busy/m0"));
});

test("builtin model list survives with no catalog at all", () => {
  const options = modelsMenuOptions([]);
  assert.equal(options.length, MODEL_LIST.length);
});
