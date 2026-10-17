import assert from "node:assert/strict";
import test from "node:test";

import {
  checkModel,
  formatModelCheckError,
  splitModelSlug,
  suggestModels,
} from "../docker/sandbox/usr/local/lib/pi-model-check.mjs";

// Shaped like Pi's get_available_models, trimmed to what the check reads.
const MODELS = [
  { provider: "openrouter", id: "anthropic/claude-opus-5.5" },
  { provider: "openrouter", id: "anthropic/claude-opus-5.5:nitro" },
  { provider: "openrouter", id: "google/gemma-4-31b-it" },
  { provider: "openrouter", id: "google/gemma-4-31b-it:free" },
  { provider: "opencode", id: "claude-opus-5-5" },
  { provider: "poolside", id: "poolside/laguna-m.1" },
];

test("splitModelSlug splits on the first slash only", () => {
  assert.deepEqual(splitModelSlug("openrouter/anthropic/claude-opus-5.5"), {
    provider: "openrouter",
    modelId: "anthropic/claude-opus-5.5",
  });
  for (const bad of ["", "   ", "claude", "/claude", "openrouter/", null]) {
    assert.equal(splitModelSlug(bad), null, String(bad));
  }
});

test("checkModel accepts only exact ids Pi lists", () => {
  assert.deepEqual(checkModel("openrouter/anthropic/claude-opus-5.5", MODELS), {
    ok: true,
    provider: "openrouter",
    modelId: "anthropic/claude-opus-5.5",
  });
  assert.equal(checkModel("poolside/poolside/laguna-m.1", MODELS).ok, true);
  assert.equal(checkModel("OpenRouter/anthropic/claude-opus-5.5", MODELS).ok, false);
});

test("the opus 5-5 slug is rejected, with the dotted id as a hint", () => {
  const r = checkModel("openrouter/anthropic/claude-opus-5-5", MODELS);
  assert.equal(r.ok, false);
  assert.deepEqual(r.suggestions, ["openrouter/anthropic/claude-opus-5.5"]);
  assert.match(r.error, /no model `anthropic\/claude-opus-5-5` for provider `openrouter`/);
  assert.match(formatModelCheckError(r), /Did you mean `openrouter\/anthropic\/claude-opus-5\.5`\?$/);
});

test("hints never offer OpenRouter variants or other providers", () => {
  // Suffixed variants (:free, :nitro) are different models, not typos.
  assert.deepEqual(suggestModels("openrouter", "google/gemma-4-31b-it:fre", MODELS), []);
  assert.deepEqual(suggestModels("openrouter", "anthropic/claude-opus-5-5", MODELS), [
    "openrouter/anthropic/claude-opus-5.5",
  ]);
  // opencode has claude-opus-5-5, but it's another provider and key.
  const r = checkModel("openrouter/claude-opus-5-5", MODELS);
  assert.equal(r.ok, false);
  assert.deepEqual(r.suggestions, []);
});

test("a provider with no available models points at /apikey", () => {
  const r = checkModel("anthropic/claude-opus-5-5", MODELS);
  assert.equal(r.ok, false);
  assert.deepEqual(r.suggestions, []);
  assert.match(r.error, /no models for provider `anthropic`.*`\/apikey provider:anthropic key:<key>`/);
  assert.equal(formatModelCheckError(r), r.error);
});

test("a slug without a provider is rejected", () => {
  const r = checkModel("claude-opus-5.5", MODELS);
  assert.equal(r.ok, false);
  assert.match(r.error, /Use `provider\/model`/);
  assert.equal(checkModel("openrouter/anthropic/claude-opus-5.5", null).ok, false);
});
