import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
