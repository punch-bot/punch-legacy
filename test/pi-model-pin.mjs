import assert from "node:assert/strict";
import test from "node:test";

import {
  addedServiceSuffix,
  modelsJsonEntry,
  planModelPin,
  withRegisteredModel,
} from "../docker/sandbox/usr/local/lib/pi-model-pin.mjs";

const free = {
  provider: "openrouter",
  id: "liquid/lfm-2.5-2.6b:free",
  name: "Liquid: LFM 2.5 2.6B (free)",
  api: "openai-completions",
  baseUrl: "https://openrouter.ai/api/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32768,
  maxTokens: 8192,
  compat: { thinkingFormat: "openrouter" },
  headers: { "x-test": "1" },
};

test("addedServiceSuffix flags OpenRouter variants the user did not ask for", () => {
  assert.equal(addedServiceSuffix("deepseek/deepseek-v3.2", "deepseek/deepseek-v3.2:batch"), "batch");
  assert.equal(addedServiceSuffix("deepseek-v3.2", "deepseek/deepseek-v3.2:free"), "free");
  assert.equal(addedServiceSuffix("x/y:free", "x/y:free"), null);
  assert.equal(addedServiceSuffix("X/Y:FREE", "x/y:free"), null);
  assert.equal(addedServiceSuffix("x/y", "x/y"), null);
  // An explicit variant followed by a thinking level still asks for the variant.
  assert.equal(addedServiceSuffix("x/y:free:high", "x/y:free"), null);
  assert.equal(addedServiceSuffix("x/y:high", "x/y:free"), "free");
  // Bedrock-style version suffixes and colons before the last slash are not variants.
  assert.equal(addedServiceSuffix("claude-opus", "us.anthropic.claude-opus-4-6-v1:0"), null);
  assert.equal(addedServiceSuffix("a", "host:8080/model"), null);
  assert.equal(addedServiceSuffix("x/y", undefined), null);
});

test("planModelPin switches to the unsuffixed model when Pi knows it", () => {
  const current = { ...free, id: "deepseek/deepseek-v3.2:batch" };
  const available = [
    { provider: "openrouter", id: "deepseek/deepseek-v3.2" },
    current,
  ];
  assert.deepEqual(planModelPin("openrouter", "deepseek-v3.2", current, available), {
    action: "use",
    id: "deepseek/deepseek-v3.2",
  });
});

test("planModelPin registers the bare id when only the variant ships", () => {
  const plan = planModelPin("openrouter", "liquid/lfm-2.5-2.6b", free, [free]);
  assert.equal(plan.action, "register");
  assert.equal(plan.id, "liquid/lfm-2.5-2.6b");
  assert.deepEqual(plan.entry, {
    id: "liquid/lfm-2.5-2.6b",
    name: "Liquid: LFM 2.5 2.6B",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    contextWindow: 32768,
    maxTokens: 8192,
  });
});

test("planModelPin only touches OpenRouter", () => {
  const custom = { provider: "local", id: "foo:thinking", name: "Foo" };
  assert.equal(planModelPin("local", "foo", custom, [custom]), null);
  assert.equal(
    planModelPin("openrouter", "x/y:free:high", { ...free, id: "x/y:free" }, [
      { provider: "openrouter", id: "x/y" },
    ]),
    null,
  );
});

test("planModelPin leaves Pi alone when nothing was added", () => {
  assert.equal(planModelPin("openrouter", "x/y:free", { ...free, id: "x/y:free" }, []), null);
  assert.equal(planModelPin("openrouter", "x/y", { ...free, id: "x/y" }, []), null);
  assert.equal(planModelPin("anthropic", "x/y", free, [free]), null);
  assert.equal(planModelPin("openrouter", "x/y", null, []), null);
});

test("modelsJsonEntry keeps only schema-safe fields", () => {
  const entry = modelsJsonEntry(
    { ...free, input: ["text", "audio"], contextWindow: -1, maxTokens: "big", reasoning: "yes" },
    "liquid/lfm-2.5-2.6b",
    "free",
  );
  assert.deepEqual(entry, {
    id: "liquid/lfm-2.5-2.6b",
    name: "Liquid: LFM 2.5 2.6B",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    input: ["text"],
  });
  assert.deepEqual(modelsJsonEntry({}, "a/b", "batch"), { id: "a/b" });
  // The supervisor re-sanitizes gateway entries without a suffix to strip.
  assert.deepEqual(
    modelsJsonEntry({ id: "a/b", name: "A (free)", cost: { input: 1 }, compat: {}, junk: 1 }, "a/b"),
    { id: "a/b", name: "A (free)" },
  );
});

test("withRegisteredModel adds the entry without touching other providers", () => {
  const poolside = { baseUrl: "https://inference.poolside.ai/v1", models: [{ id: "p" }] };
  const config = { providers: { poolside } };
  const next = withRegisteredModel(config, "openrouter", { id: "a/b" });
  assert.deepEqual(next, {
    providers: { poolside, openrouter: { models: [{ id: "a/b" }] } },
  });
  assert.deepEqual(config, { providers: { poolside } }, "input is not mutated");

  const custom = { providers: { openrouter: { apiKey: "$K", models: [{ id: "c/d" }] } } };
  assert.deepEqual(withRegisteredModel(custom, "openrouter", { id: "a/b" }).providers.openrouter, {
    apiKey: "$K",
    models: [{ id: "c/d" }, { id: "a/b" }],
  });

  assert.deepEqual(withRegisteredModel({}, "openrouter", { id: "a/b" }), {
    providers: { openrouter: { models: [{ id: "a/b" }] } },
  });
});

test("withRegisteredModel refuses duplicates and unsafe provider ids", () => {
  const config = { providers: { openrouter: { models: [{ id: "a/b" }] } } };
  assert.equal(withRegisteredModel(config, "openrouter", { id: "a/b" }), null);
  assert.equal(withRegisteredModel({}, "__proto__", { id: "a/b" }), null);
  assert.equal(withRegisteredModel({}, "../x", { id: "a/b" }), null);
});
