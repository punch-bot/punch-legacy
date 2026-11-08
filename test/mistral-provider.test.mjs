import { test } from "node:test";
import assert from "node:assert/strict";
import { MODEL_LIST, PROVIDER_NAMES } from "../src/core/config.js";
import { contextLimitFor } from "../src/agent.js";

test("mistral is an accepted provider name", () => {
  assert.ok(PROVIDER_NAMES.includes("mistral"), "without this /apikey rejects it");
});

test("every model list entry uses a provider that is accepted", () => {
  const known = new Set(PROVIDER_NAMES);
  const unknown = MODEL_LIST
    .filter((m) => m.value && m.value !== "__custom__")
    .map((m) => m.value.split("/")[0])
    .filter((prov) => !known.has(prov) && prov !== "openai-codex");
  assert.deepEqual([...new Set(unknown)], [], "model list may only offer providers the bot accepts");
});

test("mistral large 4 is offered, spelled the way the catalog spells it", () => {
  const entry = MODEL_LIST.find((m) => m.value === "mistral/mistral-large-4");
  assert.ok(entry, "Mistral Large 4 should be selectable");
  assert.match(entry.label, /Mistral Large 4/);
});

test("mistral context limits follow the catalog per model", () => {
  assert.equal(contextLimitFor("mistral/mistral-large-4"), 1048576);
  assert.equal(contextLimitFor("mistral/mistral-medium-3.5"), 262144);
  assert.equal(contextLimitFor("mistral/mistral-small-latest"), 262144, "unknown mistral models fall back conservatively");
});
