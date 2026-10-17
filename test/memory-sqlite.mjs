import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { MemoryDatabase } from "../src/memory-db.js";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "punch-sqlite-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const fact = (id, text, extra = {}) => ({ id, text, ts: Date.now(), ...extra });
const today = () => new Date().toISOString().slice(0, 10);

test("imports facts and both daily JSON formats without changing sources; cutover survives restart", (t) => {
  const dir = fixture(t);
  const source = JSON.stringify({ users: { alice: [fact("old-cpp", "knows C++", { origin: "legacy" }), fact("old-csharp", "knows C#")] }, channels: { shared: [fact("old-c", "knows C")] } });
  writeFileSync(join(dir, "memory.json"), source);
  mkdirSync(join(dir, "memory"));
  const day = today();
  const note = fact("note", "Aurora itinerary", { userId: "alice", channelId: "private", date: day, userText: "Aurora", assistantText: "Ready" });
  const daily = JSON.stringify([note]);
  writeFileSync(join(dir, "memory", `${day}.json`), daily);
  let db = new MemoryDatabase(dir);
  assert.deepEqual(db.list("user", "alice").map((e) => e.id), ["old-cpp", "old-csharp"]);
  assert.equal(db.list("user", "alice")[0].origin, "legacy");
  assert.deepEqual(db.search({ userId: "alice", channelId: "private", isDm: true, queryTerms: ["aurora"], cutoff: day }).map((e) => e.id), ["note"]);
  assert.equal(readFileSync(join(dir, "memory.json"), "utf8"), source);
  assert.equal(readFileSync(join(dir, "memory", `${day}.json`), "utf8"), daily);
  db.forget("user", "alice", "old-cpp");
  db.close();
  // Stale source files are never reimported after cutover (even when edited).
  writeFileSync(join(dir, "memory", `${day}.json`), "corrupt stale JSON");
  db = new MemoryDatabase(dir);
  assert.deepEqual(db.list("user", "alice").map((e) => e.id), ["old-csharp"]);
  assert.equal(db.list("channel", "shared").length, 1);
  db.close();
});

test("a bad daily file rolls back facts and cutover; restoring it allows a complete retry", (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, "memory.json"), JSON.stringify({ users: { alice: [fact("fact", "uses Next.js")] } }));
  mkdirSync(join(dir, "memory"));
  const file = join(dir, "memory", `${today()}.json`);
  writeFileSync(file, "{ broken");
  assert.throws(() => new MemoryDatabase(dir), /migration refused/);
  assert.equal(readFileSync(file, "utf8"), "{ broken");
  const raw = new DatabaseSync(join(dir, "memory.sqlite"));
  assert.equal(raw.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'memory_records'").get().count, 0);
  raw.close();
  writeFileSync(file, JSON.stringify({ records: [fact("note", "Next.js project", { userId: "alice", channelId: "private" })] }));
  const db = new MemoryDatabase(dir);
  assert.equal(db.list("user", "alice").length, 1);
  assert.equal(db.search({ userId: "alice", channelId: "private", isDm: true, queryTerms: ["next.js"], cutoff: today() }).length, 2);
  db.close();
});

test("malformed stores, records, duplicate IDs, and quarantined sources fail closed", (t) => {
  for (const value of ["null", "[]", '{"unexpected":"store shape"}', '{"users":[]}', JSON.stringify({ users: { alice: [{ id: "broken" }] } }), JSON.stringify({ users: { alice: [fact("same", "one"), fact("same", "two")] } })]) {
    const dir = fixture(t);
    writeFileSync(join(dir, "memory.json"), value);
    assert.throws(() => new MemoryDatabase(dir));
    assert.equal(readFileSync(join(dir, "memory.json"), "utf8"), value);
  }
  const dir = fixture(t);
  writeFileSync(join(dir, "memory.json.corrupt-123"), "{broken");
  assert.throws(() => new MemoryDatabase(dir), /restore quarantined/);
  assert.ok(!existsSync(join(dir, "memory.json")));
});

test("migration preserves normalization collisions and distinct punctuation", (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, "memory.json"), JSON.stringify({ users: { alice: [
    fact("a", "knows C++"), fact("b", "knows C#"), fact("c", "knows C"), fact("d", "  KNOWS C++ "),
  ] } }));
  const db = new MemoryDatabase(dir);
  assert.equal(db.list("user", "alice").length, 4);
  db.close();
});

test("missing or empty SQLite after cutover cannot resurrect stale JSON", (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, "memory.json"), JSON.stringify({ users: { alice: [fact("old", "stale fact")] } }));
  const db = new MemoryDatabase(dir);
  db.forget("user", "alice", "old");
  db.close();
  unlinkSync(join(dir, "memory.sqlite"));
  assert.throws(() => new MemoryDatabase(dir), /refusing to reimport stale JSON/);
  assert.ok(!existsSync(join(dir, "memory.sqlite")));
  const empty = new DatabaseSync(join(dir, "memory.sqlite")); empty.close();
  assert.throws(() => new MemoryDatabase(dir), /migration state is missing/);
});

test("independent connections and concurrent writers do not overwrite committed facts", async (t) => {
  const dir = fixture(t);
  const first = new MemoryDatabase(dir);
  const second = new MemoryDatabase(dir);
  first.insert("fact", "user", "alice", fact("one", "first fact"));
  second.insert("fact", "user", "alice", fact("two", "second fact"));
  assert.equal(first.list("user", "alice").length, 2);
  await Promise.all(Array.from({ length: 3 }, (_, worker) => new Promise((resolve, reject) => {
    const thread = new Worker(new URL("./helpers/memory-writer.js", import.meta.url), { workerData: { dataDir: dir, worker, count: 40 } });
    thread.on("error", reject);
    thread.on("exit", (code) => code ? reject(new Error(`writer exited ${code}`)) : resolve());
  })));
  assert.equal(first.list("user", "concurrent-user").length, 120);
  first.close();
  second.close();
});

test("scope, DM channel, user, retention, and data-directory boundaries isolate retrieval", (t) => {
  const db = new MemoryDatabase(fixture(t));
  const other = new MemoryDatabase(fixture(t));
  db.insert("fact", "user", "alice", fact("a", "Aurora alice"));
  db.insert("fact", "user", "bob", fact("b", "Aurora bob"));
  db.insert("fact", "channel", "guild", fact("c", "Aurora shared"));
  db.insert("daily", "dm", "alice", fact("d", "Aurora private"), "dm", today());
  db.insert("daily", "dm", "bob", fact("e", "Aurora bob private"), "dm", today());
  db.insert("daily", "dm", "alice", fact("f", "Aurora expired"), "dm", "2000-01-01");
  const search = (args = {}) => db.search({ userId: "alice", channelId: "dm", isDm: true, cutoff: today(), queryTerms: ["aurora"], ...args });
  assert.deepEqual(search().map((e) => e.id).sort(), ["a", "d"]);
  assert.deepEqual(search({ isDm: false }).map((e) => e.id), ["a"]);
  assert.deepEqual(search({ channelId: "guild" }).map((e) => e.id).sort(), ["a", "c"]);
  assert.deepEqual(other.list("user", "alice"), []);
  db.close(); other.close();
});
