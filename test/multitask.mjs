import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, after } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "punch-multitask-"));
process.env.DATA_DIR = dataDir;
const moduleUrl = new URL("../src/memory.js", import.meta.url);
moduleUrl.searchParams.set("test", `${Date.now()}-${Math.random()}`);
const memory = await import(moduleUrl.href);

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("multitask settings", () => {
  it("defaults multitask to off", () => {
    assert.equal(memory.USER_SETTINGS_DEFAULTS.multitaskEnabled, false);
    assert.equal(memory.getUserSettings("user-multitask-test").multitaskEnabled, false);
  });

  it("persists multitask toggle", () => {
    const uid = "user-multitask-toggle";
    memory.patchUserSettings(uid, { multitaskEnabled: true });
    assert.equal(memory.getUserSettings(uid).multitaskEnabled, true);
    memory.patchUserSettings(uid, { multitaskEnabled: false });
    assert.equal(memory.getUserSettings(uid).multitaskEnabled, false);
  });
});
