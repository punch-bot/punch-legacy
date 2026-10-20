import assert from "node:assert/strict";
import test from "node:test";
import { createDeviceSignin } from "../docker/sandbox/usr/local/lib/device-signin.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeLogin(outcome) {
  return async (interaction) => {
    const method = await interaction.prompt({ type: "select", options: [{ id: "browser" }, { id: "device_code" }] });
    assert.equal(method, "device_code");
    interaction.notify({ type: "device_code", userCode: "ABCD-1234", verificationUri: "https://auth.example/device", expiresInSeconds: 900 });
    return outcome.promise;
  };
}

test("device sign-in returns the code first, then saves the credential", async () => {
  const outcome = deferred();
  const saved = [];
  const signin = createDeviceSignin({ login: fakeLogin(outcome), save: (credential) => saved.push(credential), now: () => 1_000 });

  const started = await signin.start();
  assert.deepEqual(started, { status: "pending", userCode: "ABCD-1234", verificationUri: "https://auth.example/device", expiresAt: 901_000, error: undefined });
  assert.equal((await signin.start()).userCode, "ABCD-1234");

  outcome.resolve({ type: "oauth", refresh: "r" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signin.status().status, "success");
  assert.deepEqual(saved, [{ type: "oauth", refresh: "r" }]);
});

test("device sign-in reports failures and cancellation without saving", async () => {
  const saved = [];
  const failing = createDeviceSignin({ login: async () => { throw new Error("device code login is not enabled"); }, save: (c) => saved.push(c) });
  assert.deepEqual(await failing.start(), { status: "error", userCode: undefined, verificationUri: undefined, expiresAt: undefined, error: "device code login is not enabled" });

  const outcome = deferred();
  const cancelled = createDeviceSignin({ login: fakeLogin(outcome), save: (c) => saved.push(c) });
  await cancelled.start();
  cancelled.cancel();
  outcome.resolve({ type: "oauth", refresh: "late" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled.status().status, "idle");
  assert.deepEqual(saved, []);
});
