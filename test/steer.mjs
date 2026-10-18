import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, after } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "punch-steer-"));
process.env.DATA_DIR = dataDir;

const memory = await import("../src/memory.js");
const { registry } = await import("../src/core/registry.js");
const { shouldSteerTurn } = await import("../src/chat/steer.js");

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const uid = "user-steer-test";
const msg = (channelId = "chan-1") => ({ channelId, author: { id: uid } });
const busy = (channelId = "chan-1") => {
  registry.activeTurns.set(uid, { startedAt: Date.now(), phase: "thinking", channelId });
};
const idle = () => registry.activeTurns.delete(uid);

describe("shouldSteerTurn", () => {
  it("defaults on while busy, and can be turned off", () => {
    busy();
    assert.equal(shouldSteerTurn(uid, msg()), true);
    memory.patchUserSettings(uid, { steeringEnabled: false });
    assert.equal(shouldSteerTurn(uid, msg()), false);
  });

  it("steers when enabled, a turn is running in the same channel, and nothing is queued behind it", () => {
    memory.patchUserSettings(uid, { steeringEnabled: true });
    busy("chan-1");
    assert.equal(shouldSteerTurn(uid, msg("chan-1")), true);
    // queue[0] is the in-flight turn itself — it must not block steering.
    registry.userQueues.set(uid, [{ text: "in-flight" }]);
    assert.equal(shouldSteerTurn(uid, msg("chan-1")), true);
    registry.userQueues.delete(uid);
  });

  it("does not steer when idle, in a different channel, or with queued messages", () => {
    memory.patchUserSettings(uid, { steeringEnabled: true });

    idle();
    assert.equal(shouldSteerTurn(uid, msg("chan-1")), false);

    busy("chan-1");
    assert.equal(shouldSteerTurn(uid, msg("chan-2")), false);

    registry.userQueues.set(uid, [{ text: "in-flight" }, { text: "waiting" }]);
    assert.equal(shouldSteerTurn(uid, msg("chan-1")), false);
    registry.userQueues.delete(uid);
  });

  it("queues voice memos, attachments, and reaction summons instead of steering", () => {
    memory.patchUserSettings(uid, { steeringEnabled: true });
    busy("chan-1");
    assert.equal(shouldSteerTurn(uid, { ...msg("chan-1"), attachments: new Map([["a", {}]]) }), false);
    assert.equal(shouldSteerTurn(uid, msg("chan-1"), { reactedTo: "--- Reacted to ---" }), false);
    assert.equal(shouldSteerTurn(uid, { ...msg("chan-1"), attachments: new Map() }), true);
    idle();
  });

  it("respects forceQueue and pigeon opts", () => {
    memory.patchUserSettings(uid, { steeringEnabled: true });
    busy("chan-1");
    assert.equal(shouldSteerTurn(uid, msg("chan-1"), { forceQueue: true }), false);
    assert.equal(shouldSteerTurn(uid, msg("chan-1"), { pigeonFrom: "ember" }), false);
    idle();
  });
});
