import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

let importCounter = 0;

async function importMemory() {
  const mod = await import(
    `${pathToFileURL(join(process.cwd(), "src/memory.js")).href}?d=${++importCounter}`
  );
  return mod;
}

describe("PNCH-41: corrupt store quarantine (no data loss)", () => {
  it("corrupt memory.json -> quarantined, store read-only, memory.json NOT recreated", async () => {
    const DATA = mkdtempSync(join(tmpdir(), "punch-mem-"));
    process.env.DATA_DIR = DATA;
    const memFile = join(DATA, "memory.json");
    writeFileSync(memFile, "{ this is not json !!!");
    const m = await importMemory();
    // save() throws -> the refusal is propagated, callers can't report success (cubic review)
    assert.throws(() => m.remember("user", "u1", "must not clobber the corrupt file"), /\[memory\] write to .*refused/);
    const quarantined = readdirSync(DATA).filter((f) => f.startsWith("memory.json.corrupt-"));
    assert.equal(quarantined.length, 1, "exactly one quarantine rename");
    // The corrupt store must be READ-ONLY: memory.json is the quarantined-away original and
    // must NOT be silently recreated by the refused write (cubic review).
    assert.ok(!existsSync(memFile), "refused save must not recreate memory.json");
    rmSync(DATA, { recursive: true, force: true });
  });

  it("corrupt store refuses writes loudly (throws, not silent success)", async () => {
    const DATA = mkdtempSync(join(tmpdir(), "punch-mem-"));
    process.env.DATA_DIR = DATA;
    writeFileSync(join(DATA, "sessions.json"), "definitely-not-json");
    const m = await importMemory();
    assert.throws(() => m.setSession("chan1", "sess1"), /\[memory\] write to .*refused/,
      "setSession must propagate the refusal, not report success");
    rmSync(DATA, { recursive: true, force: true });
  });

  it("corrupt stores don't disable unrelated stores", async () => {
    const DATA = mkdtempSync(join(tmpdir(), "punch-mem-"));
    process.env.DATA_DIR = DATA;
    writeFileSync(join(DATA, "config.json"), "{{{ nope");
    const m = await importMemory();
    m.remember("user", "u3", "memory still writable while config is corrupt"); // different store: OK
    assert.ok(readdirSync(DATA).includes("memory.json"), "memory.json written despite corrupt config.json");
    assert.ok(readdirSync(DATA).some((f) => f.startsWith("config.json.corrupt-")));
    rmSync(DATA, { recursive: true, force: true });
  });

  it("missing memory.json -> fallback, writable (baseline)", async () => {
    const DATA = mkdtempSync(join(tmpdir(), "punch-mem-"));
    process.env.DATA_DIR = DATA;
    const m = await importMemory();
    const entry = m.remember("user", "u1", "likes rust"); // no throw on missing file
    assert.ok(entry.id);
    assert.ok(existsSync(join(DATA, "memory.json")));
    rmSync(DATA, { recursive: true, force: true });
  });
});

describe("PNCH-42: normalize keeps distinguishing punctuation", () => {
  it("C++/C#/C survive compactMemory dedupe and search discriminates", async () => {
    const DATA = mkdtempSync(join(tmpdir(), "punch-mem-"));
    process.env.DATA_DIR = DATA;
    const m = await importMemory();
    m.remember("user", "u2", "knows C++");
    m.remember("user", "u2", "knows C#");
    m.remember("user", "u2", "knows C");
  // PNCH-42: compactMemory is the real dedupe path — run it before asserting (cubic review);
  // with the old punctuation-stripping normalize these three collapsed to one entry.
  const stats = m.compactMemory({ userId: "u2" });
  assert.equal(stats.removed, 0, "C++/C#/C must not be deduped into one fact");
  const texts = m.list("user", "u2").map((e) => e.text).sort();
  assert.deepEqual(texts, ["knows C", "knows C#", "knows C++"]);
  // search discriminates: query tokenizes "C++" as its own term (terms() keeps +/#),
  // so the query for C++ does NOT match the plain-C fact.
  const hits = m.searchMemory({ userId: "u2", query: "C++", isDm: false });
  assert.ok(hits.length > 0, "C++ query must match");
  assert.equal(hits[0].text, "knows C++", "top-ranked hit for 'C++' is the C++ fact");
  assert.equal(hits.some((r) => r.text === "knows C" && r.score >= hits[0].score), false,
    "plain-C fact must not outrank the C++ fact on a C++ query");
    rmSync(DATA, { recursive: true, force: true });
  });
});
