import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryDatabase } from "../src/memory-db.js";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "punch-memory-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const fact = (id, text, extra = {}) => ({ id, text, ts: Date.now(), ...extra });
const today = () => new Date().toISOString().slice(0, 10);

test("legacy JSON imports once, leaves the sources untouched, and survives a restart", (t) => {
  const dir = fixture(t);
  const source = JSON.stringify({ users: { alice: [fact("a", "knows C++"), fact("b", "knows C#")] }, channels: { shared: [fact("c", "knows C")] } });
  writeFileSync(join(dir, "memory.json"), source);
  mkdirSync(join(dir, "memory"));
  const day = today();
  writeFileSync(join(dir, "memory", `${day}.json`), JSON.stringify([fact("note", "Aurora itinerary", { userId: "alice", channelId: "dm", date: day })]));

  let db = new MemoryDatabase(dir);
  assert.deepEqual(db.list("user", "alice").map((e) => e.id), ["a", "b"]);
  assert.deepEqual(db.search({ userId: "alice", channelId: "dm", isDm: true, queryTerms: ["aurora"], cutoff: day }).map((e) => e.id), ["note"]);
  assert.equal(readFileSync(join(dir, "memory.json"), "utf8"), source);
  db.forget("user", "alice", "a");
  db.close();

  writeFileSync(join(dir, "memory", `${day}.json`), "stale and corrupt");
  db = new MemoryDatabase(dir);
  assert.deepEqual(db.list("user", "alice").map((e) => e.id), ["b"]);
  assert.equal(db.list("channel", "shared").length, 1);
  db.close();
});

test("a failed migration rolls back completely and can be retried", (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, "memory.json"), JSON.stringify({ users: { alice: [fact("f", "uses Next.js")] } }));
  mkdirSync(join(dir, "memory"));
  const daily = join(dir, "memory", `${today()}.json`);
  writeFileSync(daily, "{ broken");
  assert.throws(() => new MemoryDatabase(dir), /migration refused/);
  assert.equal(readFileSync(daily, "utf8"), "{ broken");

  writeFileSync(daily, JSON.stringify({ records: [fact("note", "Next.js project", { userId: "alice", channelId: "dm" })] }));
  const db = new MemoryDatabase(dir);
  assert.equal(db.list("user", "alice").length, 1);
  db.close();
});

test("malformed legacy stores fail closed and keep their original bytes", (t) => {
  for (const value of ["null", "[]", '{"users":[]}', JSON.stringify({ users: { alice: [{ id: "no-text" }] } })]) {
    const dir = fixture(t);
    writeFileSync(join(dir, "memory.json"), value);
    assert.throws(() => new MemoryDatabase(dir));
    assert.equal(readFileSync(join(dir, "memory.json"), "utf8"), value);
  }
});
