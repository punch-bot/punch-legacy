import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "punch-routines-fire-"));
process.env.DATA_DIR = dataDir;
const moduleUrl = new URL("../src/chat/routines-fire.js", import.meta.url);
moduleUrl.searchParams.set("test", `${Date.now()}-${Math.random()}`);
const { verifyRoutineUser } = await import(moduleUrl.href);

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

test("verifyRoutineUser returns null when there is no header user", () => {
  assert.equal(verifyRoutineUser("some-user", null), null);
});

test("verifyRoutineUser returns the header user when body matches", () => {
  assert.equal(verifyRoutineUser("user-1", "user-1"), "user-1");
  assert.equal(verifyRoutineUser(null, "user-1"), "user-1");
});

test("verifyRoutineUser throws a 403 on header/body mismatch", () => {
  try {
    verifyRoutineUser("user-2", "user-1");
    assert.fail("expected a throw");
  } catch (error) {
    assert.equal(error.status, 403);
    assert.match(error.message, /does not match/);
  }
});