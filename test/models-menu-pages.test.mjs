import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MODELS_PER_PAGE,
  modelPage,
  modelsMenuCustomId,
  parseModelsMenuCustomId,
  renderProviderMenu,
  renderProviderModels,
  sortModelsForMenu,
} from "../src/commands/models-menu.js";

const models = Array.from({ length: 40 }, (_, i) => ({
  label: `model-${i}`,
  value: `openrouter/model-${i}`,
  contextWindow: 128000,
}));

test("models sort known families first, then alphabetically", () => {
  const sorted = sortModelsForMenu([
    { value: "openrouter/zzz-unknown" },
    { value: "openrouter/qwen3-72b" },
    { value: "openrouter/claude-sonnet" },
    { value: "openrouter/aaa-unknown" },
    { value: "openrouter/gpt-6" },
  ]);
  assert.deepEqual(sorted.map((m) => m.value), [
    "openrouter/claude-sonnet",
    "openrouter/gpt-6",
    "openrouter/qwen3-72b",
    "openrouter/aaa-unknown",
    "openrouter/zzz-unknown",
  ]);
});

test("provider menu offers providers and keeps custom model available", () => {
  const menu = renderProviderMenu({
    model: "opencode-go/deepseek-v4.1-flash",
    thinkingLevel: "medium",
    expiresAt: Date.now() + 60_000,
    providers: [{ name: "opencode-go", count: 30 }, { name: "mistral", count: 2 }],
  });
  const [providerRow] = menu.components;
  assert.equal(providerRow.components[0].options.length, 2);
  assert.equal(providerRow.components[0].options[0].data.value, "opencode-go");
  assert.match(menu.content, /\*\*Model:\*\*/);
});

test("a provider page shows custom model first and pages at fifteen", () => {
  const menu = renderProviderModels({
    provider: "openrouter",
    models,
    page: 1,
    expiresAt: Date.now() + 60_000,
    model: "openrouter/model-0",
  });
  const [modelRow, buttons] = menu.components;
  assert.equal(modelRow.components[0].options[0].data.value, "__custom__");
  assert.equal(modelRow.components[0].options.length, MODELS_PER_PAGE + 1);
  assert.equal(buttons.components.length, 3);
  assert.match(menu.content, /page 2\/3/);
  const next = buttons.components[1];
  assert.equal(next.data.custom_id, modelsMenuCustomId("model_page", parseModelsMenuCustomId(next.data.custom_id).expiresAt, "openrouter", "2"));
});

test("paging clamps past the ends and never returns an empty slice", () => {
  assert.equal(modelPage(models, 99).page, 2);
  assert.equal(modelPage(models, -5).page, 0);
  assert.equal(modelPage([], 0).pages, 1);
});
