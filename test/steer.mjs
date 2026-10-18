import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, after } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "punch-steer-"));
process.env.DATA_DIR = dataDir;

const memory = await import("../src/memory.js");
const { registry } = await import("../src/core/registry.js");
const { shouldSteerTurn, trySteerTurn } = await import("../src/chat/steer.js");

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const uid = "user-steer-test";
const msg = (channelId = "chan-1") => ({ channelId, author: { id: uid } });
const busy = (channelId = "chan-1") => {
  registry.activeTurns.set(uid, { startedAt: Date.now(), phase: "thinking", channelId, steerable: true });
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

  it("queues while the turn is still waiting for the run lock", () => {
    memory.patchUserSettings(uid, { steeringEnabled: true });
    // A routine holds the lock, so the gateway's active session is the routine's.
    registry.activeTurns.set(uid, { startedAt: Date.now(), phase: "thinking", channelId: "chan-1" });
    assert.equal(shouldSteerTurn(uid, msg("chan-1")), false);
    idle();
  });

  it("queues empty summons so the normal empty-input reply runs", async () => {
    busy("chan-1");
    assert.equal(await trySteerTurn(msg("chan-1"), "   "), false);
    idle();
  });

  it("does not steer once the chat stopped running Pi or has no session yet", async () => {
    memory.patchUserSettings(uid, { steeringEnabled: true });
    registry.activeTurns.set(uid, { startedAt: Date.now(), phase: "thinking", channelId: "chan-1", steerable: false, sessionId: "s1" });
    assert.equal(await trySteerTurn(msg("chan-1"), "hi"), false);
    registry.activeTurns.set(uid, { startedAt: Date.now(), phase: "thinking", channelId: "chan-1", steerable: true });
    assert.equal(await trySteerTurn(msg("chan-1"), "hi"), false);
    idle();
  });

  it("queues messages that link another Discord conversation", () => {
    memory.patchUserSettings(uid, { steeringEnabled: true });
    busy("chan-1");
    const linked = { ...msg("chan-1"), content: "see https://discord.com/channels/1/2/3" };
    assert.equal(shouldSteerTurn(uid, linked), false);
    idle();
  });

  it("rechecks the queue right before steering", async () => {
    memory.patchUserSettings(uid, { steeringEnabled: true });
    registry.activeTurns.set(uid, { startedAt: Date.now(), phase: "thinking", channelId: "chan-1", steerable: true, sessionId: "s1", steeredTexts: [] });
    registry.userQueues.set(uid, [{ text: "in-flight" }, { text: "queued meanwhile" }]);
    assert.equal(await trySteerTurn(msg("chan-1"), "hi"), false);
    registry.userQueues.delete(uid);
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
