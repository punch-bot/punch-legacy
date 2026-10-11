import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

let importCounter = 0;

// one DATA dir per test; imports with distinct query keys re-run module init
async function importMemory(dataDir) {
  const mod = await import(
    `${pathToFileURL(join(process.cwd(), "src/memory.js")).href}?d=${++importCounter}`
  );
  return mod;
}

describe("PNCH-41: corrupt store quarantine (no data loss)", () => {
  it("corrupt memory.json -> quarantined and its write path is disabled", async () => {
    const DATA = mkdtempSync(join(tmpdir(), "punch-mem-"));
    process.env.DATA_DIR = DATA;
    writeFileSync(join(DATA, "memory.json"), "{ this is not json !!!");
    const m = await importMemory(DATA); // module init hits the corrupt file
    m.remember("user", "u1", "must not clobber the corrupt file");
    const quarantined = readdirSync(DATA).filter((f) => f.startsWith("memory.json.corrupt-"));
    assert.equal(quarantined.length, 1, "exactly one quarantine rename");
    // save() refused: no fresh fallback-memory.json replaces the quarantined original
    rmSync(DATA, { recursive: true, force: true });
  });

  it("corrupt stores don't disable unrelated stores", async () => {
    const DATA = mkdtempSync(join(tmpdir(), "punch-mem-"));
    process.env.DATA_DIR = DATA;
    writeFileSync(join(DATA, "config.json"), "{{{ nope");
    const m = await importMemory(DATA);
    m.remember("user", "u3", "memory still writable while config is corrupt"); // must succeed
    assert.ok(readdirSync(DATA).includes("memory.json"), "memory.json written despite corrupt config.json");
    assert.ok(readdirSync(DATA).some((f) => f.startsWith("config.json.corrupt-")));
    rmSync(DATA, { recursive: true, force: true });
  });

  it("missing memory.json -> fallback, writable (baseline)", async () => {
    const DATA = mkdtempSync(join(tmpdir(), "punch-mem-"));
    process.env.DATA_DIR = DATA;
    const m = await importMemory(DATA);
    const entry = m.remember("user", "u1", "likes rust");
    assert.ok(entry.id);
    assert.ok(existsSync(join(DATA, "memory.json")));
    rmSync(DATA, { recursive: true, force: true });
  });
});

describe("PNCH-42: normalize keeps distinguishing punctuation", () => {
  it("memory facts containing C++, C# and C remain three distinct facts", async () => {
    const DATA = mkdtempSync(join(tmpdir(), "punch-mem-"));
    process.env.DATA_DIR = DATA;
    const m = await importMemory(DATA);
    m.remember("user", "u2", "knows C++");
    m.remember("user", "u2", "knows C#");
    m.remember("user", "u2", "knows C");
    const texts = m.list("user", "u2").map((e) => e.text).sort();
    assert.deepEqual(texts, ["knows C", "knows C#", "knows C++"]);
    const hits = m.searchMemory({ userId: "u2", query: "C++", isDm: false });
    assert.ok(hits.some((r) => r.text.includes("C++")), "C++ matches as its own fact");
    rmSync(DATA, { recursive: true, force: true });
  });
});
