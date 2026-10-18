import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, after } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "punch-workers-"));
process.env.DATA_DIR = dataDir;
// Settings as saved before steering replaced multitask.
writeFileSync(join(dataDir, "config.json"), JSON.stringify({
  userSettings: {
    "multitask-user": { multitaskEnabled: true, steeringEnabled: false, multitaskWorkersCap: 5, autoCompressThreshold: 60, timeZone: "UTC" },
    "snapshot-user": {
      multitaskEnabled: false, steeringEnabled: false, multitaskWorkersCap: 3,
      autoCompressThreshold: 75, trustedPigeonSenders: [], pigeonBufferSeconds: 0, timeZone: "UTC",
    },
  },
}));
const moduleUrl = new URL("../src/memory.js", import.meta.url);
moduleUrl.searchParams.set("test", `${Date.now()}-${Math.random()}`);
const memory = await import(moduleUrl.href);

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("multitask migration", () => {
  it("switches multitask and snapshotted users to steering and drops snapshotted defaults, keeping real overrides", () => {
    assert.equal("multitaskEnabled" in memory.USER_SETTINGS_DEFAULTS, false);
    for (const uid of ["multitask-user", "snapshot-user"]) {
      assert.equal(memory.getUserSettings(uid).steeringEnabled, true);
      assert.equal("multitaskEnabled" in memory.getUserSettings(uid), false);
    }
    assert.equal(memory.getUserSettings("multitask-user").multitaskWorkersCap, 5);
    const saved = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"));
    assert.equal(saved.steeringDefaultOn, true);
    assert.deepEqual(saved.userSettings["snapshot-user"], {});
    assert.deepEqual(saved.userSettings["multitask-user"], { multitaskWorkersCap: 5, autoCompressThreshold: 60 });
  });

  it("saves only overrides, and keeps a later explicit opt-out", async () => {
    memory.patchUserSettings("snapshot-user", { steeringEnabled: false });
    const saved = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"));
    assert.deepEqual(saved.userSettings["snapshot-user"], { steeringEnabled: false });
    const reloadUrl = new URL("../src/memory.js", import.meta.url);
    reloadUrl.searchParams.set("test", `reload-${Date.now()}`);
    const reloaded = await import(reloadUrl.href);
    assert.equal(reloaded.getUserSettings("snapshot-user").steeringEnabled, false);
  });
});

describe("settings migration on a non-object config.json", () => {
  it("loads without throwing", async () => {
    const primitiveDir = mkdtempSync(join(tmpdir(), "punch-workers-primitive-"));
    const previousDataDir = process.env.DATA_DIR;
    try {
      writeFileSync(join(primitiveDir, "config.json"), JSON.stringify("hello"));
      process.env.DATA_DIR = primitiveDir;
      const url = new URL("../src/memory.js", import.meta.url);
      url.searchParams.set("test", `primitive-${Date.now()}`);
      await import(url.href);
    } finally {
      process.env.DATA_DIR = previousDataDir;
      rmSync(primitiveDir, { recursive: true, force: true });
    }
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
