import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { archiveLegacyExtensions } from "../docker/sandbox/usr/local/lib/pi-runtime-migration.mjs";

function workspace(t) {
  const work = mkdtempSync(join(tmpdir(), "punch-runtime-migration-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  return work;
}

test("fresh workspaces need no legacy archive", (t) => {
  const work = workspace(t);
  assert.deepEqual(archiveLegacyExtensions(work), []);
  assert.deepEqual(readdirSync(work), []);
});

test("migration preserves edited defaults and leaves search and user extensions active", (t) => {
  const work = workspace(t);
  const extensions = join(work, ".pi", "extensions");
  mkdirSync(extensions, { recursive: true });
  const edited = "// Custom reminder logic\nexport default function routines() {}\n";
  writeFileSync(join(extensions, "routines.ts"), edited);
  writeFileSync(join(extensions, "browser.ts"), "// Old browser\n");
  writeFileSync(join(extensions, "searxng.ts"), "// Search\n");
  writeFileSync(join(extensions, "user-tool.ts"), "// User tool\n");

  const archived = archiveLegacyExtensions(work);
  assert.equal(archived.length, 2);
  assert.equal(readFileSync(join(extensions, ".legacy-pi", "routines.ts"), "utf8"), edited);
  assert.equal(readFileSync(join(extensions, ".legacy-pi", "browser.ts"), "utf8"), "// Old browser\n");
  assert.deepEqual(readdirSync(extensions).sort(), [".legacy-pi", "searxng.ts", "user-tool.ts"]);
  assert.deepEqual(archiveLegacyExtensions(work), []);
});

test("a later migration keeps earlier archived edits", (t) => {
  const work = workspace(t);
  const extensions = join(work, ".pi", "extensions");
  mkdirSync(extensions, { recursive: true });
  writeFileSync(join(extensions, "routines.ts"), "first edit");
  archiveLegacyExtensions(work);
  writeFileSync(join(extensions, "routines.ts"), "second edit");
  archiveLegacyExtensions(work);
  const archive = join(extensions, ".legacy-pi");
  assert.deepEqual(readdirSync(archive).map(name => readFileSync(join(archive, name), "utf8")).sort(), ["first edit", "second edit"]);
});
