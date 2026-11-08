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
  const expiresAt = Date.now() + 60_000;
  const menu = renderProviderModels({
    provider: "openrouter",
    models,
    page: 1,
    expiresAt,
    model: "openrouter/model-0",
    thinkingLevel: "high",
  });
  const [modelRow, buttons] = menu.components;
  assert.equal(modelRow.components[0].options[0].data.value, "__custom__");
  assert.equal(modelRow.components[0].options.length, MODELS_PER_PAGE + 1);
  assert.equal(buttons.components.length, 3);
  assert.match(menu.content, /page 2\/3/);
  const next = buttons.components[1];
  const parsed = parseModelsMenuCustomId(next.data.custom_id);
  assert.equal(parsed.base, "model_page");
  assert.deepEqual(parsed.args, ["openrouter", "2"]);
  assert.equal(parsed.expiresAt, expiresAt);
  const rendered = modelRow.components[0].options.slice(1).map((o) => o.data.value);
  assert.deepEqual(rendered, sortModelsForMenu(models).slice(15, 30).map((m) => m.value), "page 2 renders indexes 15 to 29");
  const [, thinkingRow] = [null, menu.components[2]];
  assert.match(thinkingRow.components[0].data.placeholder, /Reasoning: High/, "the saved level is shown on provider pages");
});

test("discoverable providers are deduplicated by endpoint", async () => {
  const { discoverableProviders } = await import("../src/model-catalog.js");
  const names = discoverableProviders();
  assert.equal(names.filter((n) => n === "nim" || n === "nvidia").length, 1, "nvidia and nim share an endpoint, so only one is offered");
  assert.ok(names.includes("opencode-go"));
});

test("paging clamps past the ends and never returns an empty slice", () => {
  assert.equal(modelPage(models, 99).page, 2);
  assert.equal(modelPage(models, -5).page, 0);
  assert.equal(modelPage([], 0).pages, 1);
});
