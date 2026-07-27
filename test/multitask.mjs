import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { USER_SETTINGS_DEFAULTS, getUserSettings, patchUserSettings } from "../src/memory.js";

describe("multitask settings", () => {
  it("defaults multitask to off", () => {
    assert.equal(USER_SETTINGS_DEFAULTS.multitaskEnabled, false);
    assert.equal(getUserSettings("user-multitask-test").multitaskEnabled, false);
  });

  it("persists multitask toggle", () => {
    const uid = "user-multitask-toggle";
    patchUserSettings(uid, { multitaskEnabled: true });
    assert.equal(getUserSettings(uid).multitaskEnabled, true);
    patchUserSettings(uid, { multitaskEnabled: false });
    assert.equal(getUserSettings(uid).multitaskEnabled, false);
  });
});
