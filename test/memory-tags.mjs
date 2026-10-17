import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "punch-memory-tags-"));
process.env.DATA_DIR = dataDir;
const memory = await import(new URL("../src/memory.js", import.meta.url).href);
const { persistMemoryTags } = await import(new URL("../src/chat/memory-tags.js", import.meta.url).href);

test.after(() => {
  memory.closeMemory();
  rmSync(dataDir, { recursive: true, force: true });
});

test("user-scoped remember is stored under the speaker and the tag is stripped", () => {
  const result = persistMemoryTags(
    "I'll note that. <remember scope=\"user\" id=\"123\">likes tea</remember>",
    "speaker-1",
    "channel-1",
  );
  assert.equal(result.saved, 1);
  assert.equal(result.clean, "I'll note that.");
  assert.deepEqual(memory.list("user", "speaker-1").map((entry) => entry.text), ["likes tea"]);
});

test("channel-scoped remember with a channel is stored under that channel", () => {
  persistMemoryTags('<remember scope="channel">deploys on fridays</remember>', "speaker-2", "channel-2");
  assert.deepEqual(memory.list("channel", "channel-2").map((entry) => entry.text), ["deploys on fridays"]);
});

test("channel-scoped remember without channel context is dropped, not stored under null", () => {
  const result = persistMemoryTags('<remember scope="channel">no home for this</remember>', "speaker-3", null);
  assert.equal(result.saved, 0);
  assert.equal(memory.list("channel", null).length, 0);
});

test("forget targets user memory first, then the channel when one exists", () => {
  const userEntry = memory.remember("user", "speaker-4", "old fact");
  const channelEntry = memory.remember("channel", "channel-4", "old channel fact");

  const withoutChannel = persistMemoryTags(`<forget id="${userEntry.id}"></forget>`, "speaker-4", null);
  assert.equal(withoutChannel.dropped, 1);
  assert.equal(memory.list("user", "speaker-4").length, 0);

  const withChannel = persistMemoryTags(`<forget id="${channelEntry.id}"></forget>`, "speaker-4", "channel-4");
  assert.equal(withChannel.dropped, 1);
  assert.equal(memory.list("channel", "channel-4").length, 0);
});

test("empty fact is skipped and empty input returns empty clean text", () => {
  const result = persistMemoryTags('<remember scope="user">  </remember>', "speaker-5", null);
  assert.equal(result.saved, 0);
  assert.equal(result.clean, "");
});

test("write/delete failures preserve the reply and count only successful mutations", (t) => {
  const retained = memory.remember("user", "partial", "retain this fact");
  const db = new DatabaseSync(join(dataDir, "memory.sqlite"));
  t.after(() => {
    db.exec("DROP TRIGGER reject_test_insert; DROP TRIGGER reject_test_delete;");
    db.close();
  });
  db.exec(`CREATE TRIGGER reject_test_insert BEFORE INSERT ON memory_records WHEN new.text = 'reject this fact'
    BEGIN SELECT RAISE(ABORT, 'synthetic insert failure'); END;
    CREATE TRIGGER reject_test_delete BEFORE DELETE ON memory_records WHEN old.text = 'retain this fact'
    BEGIN SELECT RAISE(ABORT, 'synthetic delete failure'); END;`);
  t.mock.method(console, "warn", () => {});
  const result = persistMemoryTags(`Useful reply.
    <remember>first persisted fact</remember><remember>reject this fact</remember>
    <remember>last persisted fact</remember><forget id="${retained.id}"></forget>`, "partial", "channel");
  assert.equal(result.clean, "Useful reply.");
  assert.deepEqual({ saved: result.saved, dropped: result.dropped, failed: result.failed }, { saved: 2, dropped: 0, failed: 2 });
  assert.deepEqual(memory.list("user", "partial").map((entry) => entry.text), ["retain this fact", "first persisted fact", "last persisted fact"]);
});

test("disabled memory strips remember/forget tags and reports failure without throwing", (t) => {
  memory.closeMemory();
  rmSync(join(dataDir, "memory.sqlite"));
  rmSync(join(dataDir, "memory.sqlite.cutover"));
  writeFileSync(join(dataDir, "memory.json"), "{broken");
  assert.equal(memory.initializeMemory({ strict: false }).available, false);
  const warnings = [];
  t.mock.method(console, "warn", (message) => warnings.push(message));
  const result = persistMemoryTags('Useful reply. <remember>private fact</remember><forget id="old-id"></forget>', "partial", "channel");
  assert.deepEqual(result, { clean: "Useful reply.", saved: 0, dropped: 0, failed: 2 });
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every((message) => message.includes("MEMORY_UNAVAILABLE") && !message.includes("private fact")));
});
