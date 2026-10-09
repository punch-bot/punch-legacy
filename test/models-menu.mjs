import assert from "node:assert/strict";
import test from "node:test";

import {
  CUSTOM_MODEL_MODAL_ID,
  MODELS_MENU_EXPIRED,
  MODELS_MENU_TTL_MS,
  MODEL_SELECT_ID,
  THINKING_SELECT_ID,
  modelsMenuCustomId,
  modelsMenuExpired,
  parseModelsMenuCustomId,
  renderModelsMenu,
  thinkingLevelLabel,
} from "../src/commands/models-menu.js";

const NOW = 1_800_000_000_000;

function selects(payload) {
  return payload.components.map((row) => row.toJSON().components[0]);
}

test("menu custom ids carry their expiry; ids without one count as expired", () => {
  const expiresAt = NOW + MODELS_MENU_TTL_MS;
  for (const base of [MODEL_SELECT_ID, THINKING_SELECT_ID, CUSTOM_MODEL_MODAL_ID]) {
    const id = modelsMenuCustomId(base, expiresAt);
    assert.ok(id.length <= 100, "Discord custom ids are capped at 100 chars");
    assert.deepEqual(parseModelsMenuCustomId(id), { base, expiresAt });
  }
  // Menus sent before this change used the bare id.
  const legacy = parseModelsMenuCustomId("model_select");
  assert.deepEqual(legacy, { base: "model_select", expiresAt: 0 });
  assert.equal(modelsMenuExpired(legacy.expiresAt, NOW), true);
  assert.equal(parseModelsMenuCustomId("model_select:junk").expiresAt, 0);
});

test("the menu expires five minutes after /models", () => {
  const expiresAt = NOW + MODELS_MENU_TTL_MS;
  assert.equal(MODELS_MENU_TTL_MS, 5 * 60_000);
  assert.equal(modelsMenuExpired(expiresAt, NOW), false);
  assert.equal(modelsMenuExpired(expiresAt, expiresAt - 1), false);
  assert.equal(modelsMenuExpired(expiresAt, expiresAt), true);
  assert.equal(modelsMenuExpired(expiresAt, expiresAt + 60_000), true);
});

test("renderModelsMenu shows separate model and reasoning dropdowns", () => {
  const expiresAt = NOW + MODELS_MENU_TTL_MS;
  const payload = renderModelsMenu({ model: "openai/gpt-4o", thinkingLevel: "high", expiresAt, now: NOW });
  const [model, thinking] = selects(payload);

  assert.equal(model.custom_id, `${MODEL_SELECT_ID}:${expiresAt}`);
  assert.equal(model.placeholder, "Model: openai/gpt-4o");
  assert.equal(model.options.find((o) => o.value === "openai/gpt-4o").description, "Currently selected");
  assert.ok(model.options.some((o) => o.value === "__custom__"));

  assert.equal(thinking.custom_id, `${THINKING_SELECT_ID}:${expiresAt}`);
  assert.equal(thinking.placeholder, "Reasoning: High");
  assert.equal(thinking.options[0].value, "default");
  assert.equal(thinking.options.find((o) => o.value === "high").description, "Currently selected");
  assert.notEqual(thinking.options[0].description, "Currently selected");

  assert.match(payload.content, /`openai\/gpt-4o`/);
  assert.match(payload.content, /Reasoning:\*\* High \(models without this level use their default\)/);
  assert.match(payload.content, new RegExp(`<t:${Math.floor(expiresAt / 1000)}:R>`));
});

test("renderModelsMenu marks Default when no level is set and keeps the notice", () => {
  const expiresAt = NOW + MODELS_MENU_TTL_MS;
  const payload = renderModelsMenu({ model: "a/b", thinkingLevel: null, expiresAt, notice: "✅ done", now: NOW });
  const [, thinking] = selects(payload);
  assert.equal(thinking.placeholder, "Reasoning: Default");
  assert.equal(thinking.options[0].description, "Currently selected");
  assert.ok(payload.content.startsWith("✅ done\n"));
  assert.match(payload.content, /Reasoning:\*\* Default\n/);
});

test("an expired menu has no components and says to run /models again", () => {
  const expiresAt = NOW - 1;
  assert.deepEqual(renderModelsMenu({ model: "a/b", expiresAt, now: NOW }), {
    content: MODELS_MENU_EXPIRED,
    components: [],
  });
  const withNotice = renderModelsMenu({ model: "a/b", expiresAt, notice: "✅ Model changed", now: NOW });
  assert.equal(withNotice.content, `✅ Model changed\n${MODELS_MENU_EXPIRED}`);
  assert.match(MODELS_MENU_EXPIRED, /Run `\/models` again/);
});

test("thinkingLevelLabel names every level and Default", () => {
  assert.equal(thinkingLevelLabel(null), "Default");
  assert.equal(thinkingLevelLabel("default"), "Default");
  assert.equal(thinkingLevelLabel("xhigh"), "Extra high");
  assert.equal(thinkingLevelLabel("weird"), "weird");
});
