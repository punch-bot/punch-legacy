import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidSandboxName, vncPorts } from "../src/sandbox-manager.js";

test("accepts Docker-safe sandbox names", () => {
  assert.equal(isValidSandboxName("ember"), true);
  assert.equal(isValidSandboxName("user-42"), true);
  assert.equal(isValidSandboxName("a".repeat(63)), true);
});

test("rejects malformed sandbox names", () => {
  for (const name of ["", "-ember", "Upper", "has space", "../escape", "a".repeat(64), null]) {
    assert.equal(isValidSandboxName(name), false, String(name));
  }
});

test("assigns stable VNC ports in configured range", () => {
  const base = vncPorts("").web;
  const first = vncPorts("ember");
  const second = vncPorts("ember");

  assert.deepEqual(first, second);
  assert.equal(first.web - first.vnc, 180);
  assert.ok(first.web >= base && first.web < base + 4000);
});
