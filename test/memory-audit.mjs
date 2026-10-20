import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "punch-memory-audit-"));
process.env.DATA_DIR = dataDir;
const memory = await import("../src/memory.js");
const { auditForSandbox, beginMemoryAudit, beginMemoryRecall, endMemoryAudit, recallForSandbox } = await import("../src/memory-recall.js");
const { persistMemoryTags } = await import("../src/chat/memory-tags.js");

test.after(() => {
  memory.closeMemory();
  rmSync(dataDir, { recursive: true, force: true });
});

test("writes dedupe and supersede, and only the audit context can merge, drop, fix, and flag", () => {
  memory.initializeMemory();
  const name = memory.remember("user", "ann", "My name is Ann");
  assert.equal(memory.remember("user", "ann", "my name is ann").id, name.id);
  memory.remember("user", "ann", "My name is Annie");
  const tea = memory.remember("user", "ann", "I prefer tea");
  const tea2 = memory.remember("user", "ann", "I really like tea");
  const job = memory.remember("user", "ann", "Works at Acme");
  const city = memory.remember("user", "ann", "Lives in Paris", { pinned: true });
  assert.deepEqual(memory.list("user", "ann").map((entry) => entry.text), ["My name is Annie", "I prefer tea", "I really like tea", "Works at Acme", "Lives in Paris"]);

  const identity = { userId: "ann" };
  const recallContext = beginMemoryRecall("ann", "dm", true);
  assert.throws(() => auditForSandbox(identity, { contextId: recallContext, action: "list" }), { status: 403 });
  const contextId = beginMemoryAudit("ann");
  assert.throws(() => auditForSandbox({ userId: "bob" }, { contextId, action: "list" }), { status: 403 });
  assert.match(auditForSandbox(identity, { contextId, action: "list" }).text, new RegExp(`\\[fact:${city.id}\\] Lives in Paris .*pinned`));

  assert.throws(() => auditForSandbox(identity, { contextId, action: "apply", changes: [{ op: "drop", id: job.id }, { op: "drop", id: city.id }] }), { status: 400 });
  assert.equal(memory.list("user", "ann").length, 5);

  auditForSandbox(identity, { contextId, action: "apply", changes: [
    { op: "merge", ids: [tea.id, tea2.id], text: "Prefers tea" },
    { op: "fix", id: city.id, text: "Lives in Berlin" },
    { op: "flag", id: job.id },
    { op: "add", text: "Plays chess" },
  ] });
  endMemoryAudit(contextId);
  assert.throws(() => auditForSandbox(identity, { contextId, action: "list" }), { status: 403 });
  assert.deepEqual(memory.list("user", "ann").map((entry) => [entry.text, entry.confirmed, entry.pinned === true]),
    [["My name is Annie", true, false], ["Prefers tea", true, false], ["Works at Acme", false, false], ["Lives in Berlin", true, true], ["Plays chess", true, false]]);
  assert.doesNotMatch(memory.coreProfile("ann"), /Acme/);
  assert.match(recallForSandbox(identity, { query: "acme" }).text, /\(unconfirmed\) Works at Acme/);
  assert.ok(memory.list("user", "ann").find((entry) => entry.id === job.id).lastUsed);
  const { last, unconfirmed } = memory.memoryAuditStatus("ann");
  assert.deepEqual([last.added, last.merged, last.dropped, last.fixed, last.flagged, unconfirmed], [1, 1, 0, 1, 1, 1]);

  persistMemoryTags(`ok <remember replaces="${job.id}">Works at Acme Corp</remember>`, "ann", "dm");
  assert.deepEqual(memory.list("user", "ann").filter((entry) => entry.id === job.id).map((entry) => [entry.text, entry.confirmed]), [["Works at Acme Corp", true]]);
});
