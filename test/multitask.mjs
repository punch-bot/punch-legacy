import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

describe("worker channelId regression", () => {
  it("startWorker accepts channelId/messageId/source without ReferenceError", () => {
    const source = readFileSync(new URL("../docker/sandbox/usr/local/lib/worker-manager.mjs", import.meta.url), "utf8");
    assert.match(
      source,
      /startWorker\(\{\s*prompt,\s*kind = "research",\s*model,\s*timeoutMs = 600_000,\s*maxTokens = 2_000,\s*channelId = null,\s*messageId = null,\s*source = null/,
    );
    assert.match(source, /channelId: channelId \? String\(channelId\) : null/);
  });
});
