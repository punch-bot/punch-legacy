import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = mkdtempSync(join(tmpdir(), "sandbox-manager-test-"));
process.env.DATA_DIR = tmpDir;

const { isValidSandboxName, botTokenFor, resolveBotToken, addUser, removeUser, sandboxRunArgs } =
  await import("../src/sandbox-manager.js");

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

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

test("botTokenFor mints a stable per-sandbox bearer token", () => {
  const t1 = botTokenFor("ember");
  const t2 = botTokenFor("ember");
  assert.ok(typeof t1 === "string" && t1.length >= 40);
  assert.equal(t1, t2);
  assert.notEqual(botTokenFor("ember"), botTokenFor("astra"));
});

test("resolveBotToken maps a token back to its sandbox owner", () => {
  addUser("ember", "111");
  const token = botTokenFor("ember");
  assert.deepEqual(resolveBotToken(token), { name: "ember", userId: "111" });
  assert.equal(resolveBotToken("bogus"), null);
  assert.equal(resolveBotToken(""), null);
  assert.equal(resolveBotToken(null), null);
});

test("removing a user also invalidates their bot token", () => {
  addUser("astra", "222");
  const token = botTokenFor("astra");
  assert.ok(resolveBotToken(token));
  removeUser("astra");
  assert.equal(resolveBotToken(token), null);
});

test("managed sandbox creation supplies the bot address/token and the shared network", (t) => {
  addUser("recall-test", "333");
  const originalUrl = process.env.PUNCH_BOT_URL;
  t.after(() => {
    if (originalUrl === undefined) delete process.env.PUNCH_BOT_URL;
    else process.env.PUNCH_BOT_URL = originalUrl;
  });
  process.env.PUNCH_BOT_URL = "http://custom-bot:4098";
  const args = sandboxRunArgs("recall-test");
  const env = new Map(args.flatMap((value, index) => value === "--env" ? [args[index + 1].split(/=(.*)/s).slice(0, 2)] : []));
  assert.equal(env.get("PUNCH_BOT_URL"), "http://custom-bot:4098");
  assert.deepEqual(resolveBotToken(env.get("PUNCH_BOT_TOKEN")), { name: "recall-test", userId: "333" });
  assert.equal(args[args.indexOf("--network") + 1], `${process.env.PUNCH_STACK_NAME || "punch"}_edge`);
  assert.ok(args.includes("sandbox-recall-test"));
  delete process.env.PUNCH_BOT_URL;
  assert.ok(sandboxRunArgs("recall-test").includes("PUNCH_BOT_URL=http://bot:4098"));
});
