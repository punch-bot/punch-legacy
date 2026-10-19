import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { archiveLegacyExtensions } from "../docker/sandbox/usr/local/lib/pi-runtime-migration.mjs";

function extensionsDir(t) {
  const work = mkdtempSync(join(tmpdir(), "punch-runtime-migration-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const extensions = join(work, ".pi", "extensions");
  mkdirSync(extensions, { recursive: true });
  return { work, extensions };
}

test("recreating a sandbox archives bundled tools without losing user edits", (t) => {
  const { work, extensions } = extensionsDir(t);
  writeFileSync(join(extensions, "routines.ts"), "custom edit");
  writeFileSync(join(extensions, "searxng.ts"), "search");
  writeFileSync(join(extensions, "user-tool.ts"), "mine");

  assert.equal(archiveLegacyExtensions(work).length, 1);
  assert.equal(readFileSync(join(extensions, ".legacy-pi", "routines.ts"), "utf8"), "custom edit");
  assert.deepEqual(readdirSync(extensions).sort(), [".legacy-pi", "searxng.ts", "user-tool.ts"]);
  assert.deepEqual(archiveLegacyExtensions(work), []);
});

test("repeated migrations keep every earlier archived copy", (t) => {
  const { work, extensions } = extensionsDir(t);
  writeFileSync(join(extensions, "routines.ts"), "first edit");
  archiveLegacyExtensions(work);
  writeFileSync(join(extensions, "routines.ts"), "second edit");
  archiveLegacyExtensions(work);
  const archive = join(extensions, ".legacy-pi");
  assert.deepEqual(readdirSync(archive).map((name) => readFileSync(join(archive, name), "utf8")).sort(), ["first edit", "second edit"]);
});
