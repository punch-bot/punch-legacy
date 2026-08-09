import test from "node:test";
import assert from "node:assert/strict";
import {
  promptBlock,
  channelContextBlock,
  thisTurnInstructions,
  reactedToBlock,
  repliedToBlock,
  pigeonSupervisorBlock,
  memoryBlock,
  timestampLine,
  multitaskPrompt,
  userTurnLine,
  assemblePrompt,
} from "../src/prompt-blocks.js";
import { pigeonTurnPreamble } from "../src/pigeon-supervisor.js";

test("promptBlock wraps body in matching header/footer", () => {
  assert.equal(
    promptBlock("My section", "line one\nline two"),
    "--- My section ---\nline one\nline two\n--- End My section ---",
  );
});

test("promptBlock returns empty string for empty body", () => {
  assert.equal(promptBlock("Empty", ""), "");
  assert.equal(promptBlock("Empty", "   "), "");
});

test("channelContextBlock has no leading blank line and normalized footer", () => {
  assert.equal(
    channelContextBlock([
      { author: "Alice", content: "hi" },
      { author: "Bob", content: "yo" },
    ]),
    [
      "--- Channel context (background only) ---",
      "[Alice] hi",
      "[Bob] yo",
      "--- End channel context ---",
    ].join("\n"),
  );
});

test("thisTurnInstructions opens with the This turn marker", () => {
  const block = thisTurnInstructions();
  assert.ok(block.startsWith("--- This turn ---"));
  assert.match(block, /<react emoji=/);
  assert.match(block, /tag\(s\)/);
  assert.match(block, /applies them automatically/);
  assert.match(block, /Do not use Discord API/);
  assert.match(block, /curl/);
  assert.match(block, /channel\/message IDs/);
});

test("reactedToBlock and repliedToBlock use normalized footers", () => {
  assert.equal(
    reactedToBlock("Alice", "hello"),
    "--- Reacted-to message ---\n[Alice]: hello\n--- End reacted-to message ---",
  );
  assert.equal(
    repliedToBlock("Bob", "(empty message)"),
    "--- Replied-to message ---\n[Bob]: (empty message)\n--- End replied-to message ---",
  );
});

test("pigeonSupervisorBlock keeps its uppercase markers", () => {
  const block = pigeonSupervisorBlock("body text");
  assert.equal(block, "--- PIGEON SUPERVISOR ---\nbody text\n--- End PIGEON SUPERVISOR ---");
});

test("pigeonTurnPreamble uses the shared block builders", () => {
  const block = pigeonTurnPreamble("ember", 0, "ember");
  assert.ok(block.startsWith("--- PIGEON SUPERVISOR ---"));
  assert.ok(block.endsWith("--- End PIGEON SUPERVISOR ---"));
  assert.match(block, /hop 0/);
});

test("memoryBlock renders project and related memory", () => {
  const block = memoryBlock({
    projectMemory: "## Guidelines\nkeep it simple",
    relatedText: "- [memory:user:ab12] prefers concise replies",
  });
  assert.equal(
    block,
    [
      "--- Punch memory ---",
      "Project memory (update /work/.punch-memory.md when needed):",
      "## Guidelines",
      "keep it simple",
      "",
      "Related memory (auto-retrieved — may be stale; verify before relying):",
      "- [memory:user:ab12] prefers concise replies",
      "--- End Punch memory ---",
    ].join("\n"),
  );
});

test("memoryBlock omits empty halves and returns empty when both missing", () => {
  const onlyProject = memoryBlock({ projectMemory: "## Project\nx" });
  assert.match(onlyProject, /Project memory/);
  assert.doesNotMatch(onlyProject, /Related memory/);

  const onlyRelated = memoryBlock({ relatedText: "- [daily:2026-08-07:xy] note" });
  assert.doesNotMatch(onlyRelated, /Project memory/);
  assert.match(onlyRelated, /Related memory/);

  assert.equal(memoryBlock({}), "");
  assert.equal(memoryBlock(), "");
});

test("timestampLine reports the message send time", () => {
  assert.equal(timestampLine("Saturday, August 8, 2026 at 3:42:00 PM EDT (America/New_York)"), "Message sent at Saturday, August 8, 2026 at 3:42:00 PM EDT (America/New_York).");
});

test("multitaskPrompt nests the channel context block", () => {
  const prompt = multitaskPrompt("do the thing", [{ author: "Alice", content: "please" }]);
  assert.ok(prompt.startsWith("--- Multitask subtask ---"));
  assert.match(prompt, /Work independently/);
  assert.match(prompt, /return concise results/);
  assert.match(prompt, /--- Channel context \(background only\) ---/);
  assert.match(prompt, /\[Alice\] please/);
  assert.ok(prompt.endsWith("do the thing"));
});

test("multitaskPrompt omits channel context when empty", () => {
  const prompt = multitaskPrompt("standalone", []);
  assert.doesNotMatch(prompt, /Channel context/);
  assert.match(prompt, /Work independently/);
  assert.match(prompt, /return concise results/);
  assert.ok(prompt.endsWith("standalone"));
});

test("multitaskPrompt includes the timestamp line when provided", () => {
  const prompt = multitaskPrompt("do the thing", [], "Saturday, August 8, 2026 at 3:42:00 PM EDT (America/New_York)");
  assert.match(prompt, /\n\nMessage sent at Saturday, August 8, 2026 at 3:42:00 PM EDT \(America\/New_York\)\.\n\ndo the thing$/);
});

test("multitaskPrompt omits the timestamp when absent", () => {
  assert.doesNotMatch(multitaskPrompt("standalone", []), /was sent at/);
  assert.doesNotMatch(multitaskPrompt("do the thing", [{ author: "Alice", content: "please" }]), /was sent at/);
});

test("userTurnLine and assemblePrompt build the final user line", () => {
  assert.equal(userTurnLine("123", "Bob (@bob, id:123)", "hi"), "[user:123] Bob (@bob, id:123): hi");
  assert.equal(assemblePrompt(["a", "", "b"], "[user:123] Bob: hi"), "a\n\nb\n\n[user:123] Bob: hi");
  assert.equal(assemblePrompt([], "[user:123] Bob: hi"), "[user:123] Bob: hi");
});
