import assert from "node:assert/strict";
import test from "node:test";

import {
  PI_DEFAULT_THINKING_LEVEL,
  THINKING_LEVELS,
  mergePiSettings,
  normalizeThinkingLevel,
  piDefaultThinkingLevel,
  turnThinkingLevel,
  withDefaultThinkingLevel,
} from "../docker/sandbox/usr/local/lib/pi-thinking-level.mjs";
import { THINKING_LEVEL_LIST } from "../src/core/config.js";

test("normalizeThinkingLevel accepts Pi levels and maps everything else to default (null)", () => {
  assert.equal(normalizeThinkingLevel("high"), "high");
  assert.equal(normalizeThinkingLevel(" XHigh "), "xhigh");
  assert.equal(normalizeThinkingLevel("off"), "off");
  for (const v of [null, undefined, "", "default", "ultra", "__proto__", 3]) {
    assert.equal(normalizeThinkingLevel(v), null, String(v));
  }
});

test("the /models dropdown offers Default plus exactly Pi's levels", () => {
  const values = THINKING_LEVEL_LIST.map((l) => l.value);
  assert.equal(values[0], "default");
  assert.deepEqual(values.slice(1), THINKING_LEVELS);
});

test("turnThinkingLevel applies a level only when the model lists it", () => {
  const reasoning = ["off", "minimal", "low", "medium", "high"];
  assert.equal(turnThinkingLevel("high", reasoning, "medium"), "high");
  assert.equal(turnThinkingLevel("off", reasoning, "medium"), "off");
  // Pi would clamp xhigh to high; Punch falls back to the default instead.
  assert.equal(turnThinkingLevel("xhigh", reasoning, "medium"), "medium");
  // Non-reasoning models only list "off".
  assert.equal(turnThinkingLevel("high", ["off"], "medium"), "medium");
  assert.equal(turnThinkingLevel("off", ["off"], "medium"), "off");
  // A model that can't disable reasoning (thinkingLevelMap.off = null).
  assert.equal(turnThinkingLevel("off", ["minimal", "low", "medium", "high"], "medium"), "medium");
});

test("turnThinkingLevel uses the default when nothing is chosen or support is unknown", () => {
  assert.equal(turnThinkingLevel(null, THINKING_LEVELS, "medium"), "medium");
  assert.equal(turnThinkingLevel("default", THINKING_LEVELS, "low"), "low");
  assert.equal(turnThinkingLevel("high", null, "medium"), "medium");
  assert.equal(turnThinkingLevel("high", undefined, "medium"), "medium");
});

test("piDefaultThinkingLevel follows Pi: per-model setting, global default, then medium", () => {
  assert.equal(piDefaultThinkingLevel({}, "openai", "gpt-5"), PI_DEFAULT_THINKING_LEVEL);
  assert.equal(piDefaultThinkingLevel(undefined, undefined, undefined), "medium");
  const settings = {
    defaultThinkingLevel: "low",
    modelThinkingLevels: { "openai/gpt-5": "high", "x/bad": "nope" },
  };
  assert.equal(piDefaultThinkingLevel(settings, "openai", "gpt-5"), "high");
  assert.equal(piDefaultThinkingLevel(settings, "anthropic", "claude"), "low");
  assert.equal(piDefaultThinkingLevel(settings, "x", "bad"), "low");
  assert.equal(piDefaultThinkingLevel({ defaultThinkingLevel: "bogus" }, "a", "b"), "medium");
});

test("mergePiSettings lets project settings override global ones per key", () => {
  const merged = mergePiSettings(
    { defaultThinkingLevel: "low", modelThinkingLevels: { "a/1": "high", "a/2": "low" }, theme: "dark" },
    { modelThinkingLevels: { "a/2": "max" } },
  );
  assert.deepEqual(merged, {
    defaultThinkingLevel: "low",
    modelThinkingLevels: { "a/1": "high", "a/2": "max" },
  });
  assert.equal(mergePiSettings({ defaultThinkingLevel: "low" }, { defaultThinkingLevel: "off" }).defaultThinkingLevel, "off");
  assert.deepEqual(mergePiSettings(), { defaultThinkingLevel: undefined, modelThinkingLevels: {} });
});

test("withDefaultThinkingLevel states medium in Pi settings unless a valid default is there", () => {
  assert.deepEqual(withDefaultThinkingLevel({}), { defaultThinkingLevel: "medium" });
  assert.deepEqual(withDefaultThinkingLevel(undefined), { defaultThinkingLevel: "medium" });
  // Other settings survive.
  assert.deepEqual(
    withDefaultThinkingLevel({ theme: "dark", modelThinkingLevels: { "a/b": "high" } }),
    { theme: "dark", modelThinkingLevels: { "a/b": "high" }, defaultThinkingLevel: "medium" },
  );
  // A level the user (or Pi) already chose is kept.
  assert.equal(withDefaultThinkingLevel({ defaultThinkingLevel: "high" }), null);
  assert.equal(withDefaultThinkingLevel({ defaultThinkingLevel: "off" }), null);
  // Pi would read these as "off", so they get replaced.
  assert.deepEqual(withDefaultThinkingLevel({ defaultThinkingLevel: "High" }), { defaultThinkingLevel: "medium" });
  assert.deepEqual(withDefaultThinkingLevel({ defaultThinkingLevel: "bogus" }), { defaultThinkingLevel: "medium" });
});
