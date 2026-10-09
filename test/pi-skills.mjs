import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { syncPiSkillSettings } from "../docker/sandbox/usr/local/lib/skills-manager.mjs";

const gateway = readFileSync(new URL("../docker/sandbox/usr/local/bin/pi-gateway.mjs", import.meta.url), "utf8");
const promptBuilder = gateway.slice(gateway.indexOf("function buildUserPrompt("), gateway.indexOf("function extractTextFromParts("));
const buildUserPrompt = runInNewContext(`${promptBuilder}\nbuildUserPrompt;`, {
  hashStr: (text) => createHash("sha1").update(text).digest("hex"),
  enabledSkillInstructions: () => { throw new Error("Skill bodies must never be injected into chat prompts"); },
});

test("new chats include only the supplied Punch context, without eager skill loading", () => {
  for (let i = 0; i < 2; i++) {
    const session = { systemHash: null };
    assert.equal(buildUserPrompt(session, "hello", ""), "hello");
    assert.equal(buildUserPrompt(session, "first", "Punch context"), "<punch-system>\nPunch context\n</punch-system>\n\nfirst");
    assert.equal(buildUserPrompt(session, "second", "Punch context"), "second");
    assert.equal(buildUserPrompt(session, "third", "Updated context"), "<punch-system>\nUpdated context\n</punch-system>\n\nthird");
  }
  assert.doesNotMatch(gateway, /function enabledSkillInstructions|SKILL_ROOTS|SKILL_ENABLED_FILE/);
});

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "punch-skills-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const work = join(directory, "work");
  const agentDir = join(directory, "agent");
  const roots = [
    { source: "workspace", directory: join(work, ".pi", "skills") },
    { source: "user", directory: join(directory, "user-skills") },
    { source: "bundled", directory: join(directory, "bundled-skills") },
  ];
  const enabledFile = join(directory, "skills-enabled.json");
  mkdirSync(agentDir, { recursive: true });
  return { work, agentDir, enabledFile, roots };
}

const readSettings = (file) => JSON.parse(readFileSync(file, "utf8"));

test("native discovery registers additional roots and preserves existing settings", (t) => {
  const options = fixture(t);
  const file = join(options.agentDir, "settings.json");
  const original = { defaultThinkingLevel: "high", skills: ["/custom/skills"], packages: ["/custom/package"] };
  writeFileSync(file, JSON.stringify(original));
  syncPiSkillSettings(options);
  assert.deepEqual(readSettings(file), {
    ...original,
    skills: ["/custom/skills", options.roots[1].directory, options.roots[2].directory],
  });
  assert.equal(existsSync(join(options.work, ".pi", "settings.json")), false);
  const mtime = statSync(file).mtimeMs;
  syncPiSkillSettings(options);
  assert.equal(statSync(file).mtimeMs, mtime);
});

test("disabled skills are excluded in every root and re-enabling removes the exclusions", (t) => {
  const options = fixture(t);
  const globalFile = join(options.agentDir, "settings.json");
  const projectFile = join(options.work, ".pi", "settings.json");
  mkdirSync(join(options.work, ".pi"), { recursive: true });
  writeFileSync(projectFile, JSON.stringify({ skills: ["/project/custom"], theme: "dark" }));
  writeFileSync(options.enabledFile, JSON.stringify({ search: false }));
  syncPiSkillSettings(options);
  for (const root of options.roots) {
    assert.ok(readSettings(globalFile).skills.includes(`-${join(root.directory, "search")}`));
    assert.ok(readSettings(globalFile).skills.includes(`-${join(root.directory, "search", "SKILL.md")}`));
  }
  assert.deepEqual(readSettings(projectFile), {
    theme: "dark",
    skills: ["/project/custom", `-${join(options.roots[0].directory, "search")}`, `-${join(options.roots[0].directory, "search", "SKILL.md")}`],
  });
  writeFileSync(options.enabledFile, JSON.stringify({ search: true }));
  syncPiSkillSettings(options);
  assert.deepEqual(readSettings(globalFile).skills, options.roots.slice(1).map((root) => root.directory));
  assert.deepEqual(readSettings(projectFile), { skills: ["/project/custom"], theme: "dark" });
});

test("skill registration never overwrites malformed Pi settings", (t) => {
  const options = fixture(t);
  const file = join(options.agentDir, "settings.json");
  writeFileSync(file, "invalid JSON");
  assert.throws(() => syncPiSkillSettings(options), SyntaxError);
  assert.equal(readFileSync(file, "utf8"), "invalid JSON");
});
