import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MODELS_PER_PAGE,
  filterByVendor,
  formatContext,
  modelPage,
  vendorOf,
  modelsMenuCustomId,
  parseModelsMenuCustomId,
  renderProviderMenu,
  renderProviderModels,
  sortModelsForMenu,
  vendorChoices,
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
  const expiresAt = Date.now() + 60_000;
  const menu = renderProviderMenu({
    model: "opencode-go/deepseek-v4.1-flash",
    thinkingLevel: "medium",
    expiresAt,
    providers: [{ name: "opencode-go", count: 30 }, { name: "mistral", count: 2 }],
    currentLabel: "DeepSeek V4.1 Flash",
    currentContextWindow: 1_048_576,
  });
  assert.match(menu.content, /### Current model: DeepSeek V4\.1 Flash/, "the provider menu resolves the label, not the raw id");
  assert.match(menu.content, /-# opencode-go · 1\.0mil context/);
  assert.match(menu.content, /-# expires <t:\d+:R>/, "expiry is small text above the header");
  const [providerRow] = menu.components;
  assert.equal(providerRow.components[0].options.length, 2);
  assert.equal(providerRow.components[0].options[0].data.value, "opencode-go");
  assert.match(menu.content, /^-# expires <t:\d+:R>\n### Current model:/, "expiry sits above the heading");
});

test("a provider page shows custom model first, vendors and paging", () => {
  const expiresAt = Date.now() + 60_000;
  const menu = renderProviderModels({
    provider: "openrouter",
    models,
    page: 1,
    expiresAt,
    model: "openrouter/anthropic/claude-sonnet",
    modelLabel: "Claude Sonnet",
    modelContextWindow: 200000,
    modelDescription: "Long-context reasoning model.",
    thinkingLevel: "high",
  });
  const [navRow, modelRow, thinkingRow2, pageRow] = menu.components;
  assert.match(menu.content, /### Current model: Claude Sonnet/, "the current model shows its label, not the raw id");
  assert.doesNotMatch(menu.content, /\d+ models · expires/, "the count moved to the page indicator");
  assert.equal(navRow.components[0].data.label, "← Back to providers");
  assert.equal(navRow.components[1].data.disabled, true);
  assert.equal(modelRow.components[0].options[0].data.value, "__custom__");
  assert.equal(modelRow.components[0].options.length, MODELS_PER_PAGE + 1);
  assert.equal(thinkingRow2.components[0].data.placeholder, "Reasoning: High");
  assert.equal(pageRow.components[1].data.label, "Page 2 / 3 · 40 models");
  const parsed = parseModelsMenuCustomId(pageRow.components[2].data.custom_id);
  assert.equal(parsed.base, "model_page");
  assert.equal(parsed.expiresAt, expiresAt);
  assert.deepEqual(parsed.args, ["openrouter", "-", "2"]);
  const rendered = modelRow.components[0].options.slice(1).map((o) => o.data.value);
  assert.deepEqual(rendered, sortModelsForMenu(models).slice(15, 30).map((m) => m.value));
});

test("vendors are derived from model ids and filter the list", () => {
  const mixed = [
    { label: "Claude Sonnet", value: "openrouter/anthropic/claude-sonnet", contextWindow: 200000 },
    { label: "GPT-6", value: "openrouter/openai/gpt-6", contextWindow: 400000 },
    { label: "GPT-6 mini", value: "openrouter/openai/gpt-6-mini", contextWindow: 400000 },
    { label: "Bare model", value: "openrouter/bare-model" },
  ];
  assert.deepEqual(vendorChoices(mixed, "openrouter"), [
    { name: "openai", count: 2 },
    { name: "anthropic", count: 1 },
  ]);
  assert.equal(filterByVendor(mixed, "openrouter", "openai").length, 2);
  assert.equal(vendorOf("openrouter/bare-model", "openrouter"), "", "a model without a vendor segment has no vendor");
  assert.ok(vendorChoices([{ value: "nvidia/nvidia/llama-3" }], "nvidia").some((v) => v.name === "nvidia"), "a vendor named like its provider is still selectable");
  assert.equal(filterByVendor(mixed, "openrouter", "-").length, 4);
  const menu = renderProviderModels({ provider: "openrouter", models: mixed, expiresAt: Date.now() + 60_000, model: "openrouter/openai/gpt-6", vendor: "openai" });
  const vendorRow = menu.components[1];
  assert.equal(vendorRow.components[0].data.placeholder, "Vendor: openai");
  assert.equal(vendorRow.components[0].options[0].data.value, "-");
  const rendered = menu.components[2].components[0].options.slice(1).map((o) => o.data.value);
  assert.deepEqual(rendered, ["openrouter/openai/gpt-6", "openrouter/openai/gpt-6-mini"], "only the selected vendor's models render");
});

test("context sizes read like a person wrote them", () => {
  assert.equal(formatContext(1_000_000), "1mil");
  assert.equal(formatContext(1_048_576), "1.0mil");
  assert.equal(formatContext(262_144), "262k");
  assert.equal(formatContext(0), null);
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
