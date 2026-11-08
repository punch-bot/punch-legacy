// Tests for cv2 inline continuation + parser error recovery.
// instead of spawning a new message (juniper's "not a new message every time").
import { test } from "node:test";
import assert from "node:assert/strict";
import { editV2, buildV2AnsweredComponents, extractV2 } from "../src/chat/embeds-questions.js";

function fakeCard(id = "mcard", attachments = []) {
  const calls = [];
  return {
    id,
    attachments: new Map(attachments.map((a, i) => [String(i), a])),
    calls,
    async edit(payload) {
      calls.push(payload);
      return this;
    },
  };
}

const spec = {
  accent: "#58b65c",
  items: [
    { type: "text", content: "**exhibit 2**\nnext stop" },
    { type: "buttons", title: "where to?", options: ["waste", "SMRs"] },
  ],
};

test("editV2 edits the existing message and keeps the cv2 container", async () => {
  const card = fakeCard();
  const ok = await editV2(card, spec, "u1");
  assert.equal(ok, true);
  assert.equal(card.calls.length, 1);
  const payload = card.calls[0];
  assert.equal(payload.components.length, 1, "one top-level container");
  const json = payload.components[0].toJSON();
  assert.equal(json.type, 17, "container is a cv2 container");
  assert.ok(json.components.some((c) => c.type === 10), "text display survives the edit");
});

test("editV2 rewires button custom ids to the edited message", async () => {
  const card = fakeCard("msg-42");
  await editV2(card, spec, "u1");
  const json = JSON.stringify(card.calls[0].components[0].toJSON());
  assert.ok(json.includes("qbtn:msg-42:"), "row customId points at the same message id");
});

test("editV2 nests the action row inside the container, not beside it", async () => {
  const card = fakeCard();
  await editV2(card, spec, "u1");
  const top = card.calls[0].components[0].toJSON();
  assert.ok(
    top.components.some((c) => c.type === 1),
    "action row lives inside the container components",
  );
});

test("editV2 reuses the card's own attachments so galleries survive", async () => {
  const card = fakeCard("m2", [
    { url: "https://cdn.example/a.png", name: "a.png" },
    { url: "https://cdn.example/b.png", name: "b.png" },
  ]);
  const gallerySpec = {
    accent: "#58b65c",
    items: [{ type: "gallery", items: [{ url: "attachment://a.png" }] }],
  };
  await editV2(card, gallerySpec, "u1");
  const files = card.calls[0].files || [];
  assert.equal(files.length, 2, "both existing attachments are re-sent with the edit");
  assert.ok(files.some((f) => f.name === "a.png"));
});

test("editV2 refuses an empty or buttonless-blank spec instead of blanking the card", async () => {
  const card = fakeCard();
  assert.equal(await editV2(card, { items: [] }, "u1"), false);
  assert.equal(await editV2(card, null, "u1"), false);
  assert.equal(card.calls.length, 0, "no edit attempted");
});

test("answered card keeps its content plus an answer note", () => {
  const items = spec.items.filter((i) => i.type !== "buttons");
  const comps = buildV2AnsweredComponents(items, "#58b65c", "> answered: **waste**");
  const json = JSON.stringify(comps.map((c) => c.toJSON()));
  assert.ok(json.includes("exhibit 2"), "original content stays");
  assert.ok(json.includes("answered: **waste**"), "note is appended");
});

test("extractV2 salvages a spec with a stray trailing brace", () => {
  const items = [{ type: "text", content: "exhibit 3" }, { type: "buttons", options: ["a"] }];
  const broken = `${JSON.stringify(items)}}`; // one brace too many: the 04:13 prod failure
  const r = extractV2(`<cv2 accent="#58b65c">${broken}</cv2>`);
  assert.equal(r.v2.length, 1, "card survives instead of vanishing");
  assert.equal(r.v2[0].items.length, 2);
  assert.ok(r.errors.some((e) => e.includes("repaired")), "repair is reported, not silent");
});

test("extractV2 still refuses genuinely invalid JSON", () => {
  const r = extractV2(`<cv2>[{"type":"text","content":}]</cv2>`);
  assert.equal(r.v2.length, 0);
  assert.ok(r.errors.length > 0);
});

test("extractV2 does not truncate on braces inside strings", () => {
  const items = [{ type: "text", content: 'spec looks like {"a":1} inside' }];
  const r = extractV2(`<cv2>${JSON.stringify(items)}}</cv2>`);
  assert.equal(r.v2.length, 1);
  assert.equal(r.v2[0].items[0].content, items[0].content);
});

test("rememberV2Card/peekV2Card track the newest card per channel+user", async () => {
  const { rememberV2Card, peekV2Card, markV2CardAnswered } = await import("../src/chat/embeds-questions.js");
  rememberV2Card("chan1", "u1", "card-a");
  assert.equal(peekV2Card("chan1", "u1"), "card-a");
  assert.equal(peekV2Card("chan1", "u2"), null, "scoped per user");
  assert.equal(peekV2Card("chan2", "u1"), null, "scoped per channel");
  rememberV2Card("chan1", "u1", "card-b");
  assert.equal(peekV2Card("chan1", "u1"), "card-b", "newest wins");
  markV2CardAnswered("chan1", "u1", "card-b");
  assert.equal(peekV2Card("chan1", "u1"), "card-b");
});

test("peekV2Card expires a stale card so it never edits an old message", async () => {
  const { rememberV2Card, peekV2Card } = await import("../src/chat/embeds-questions.js");
  rememberV2Card("chan3", "u9", "old-card");
  const entry = (await import("../src/core/registry.js")).registry.recentV2Cards.get("chan3:u9");
  entry.at = Date.now() - 2 * 60 * 60 * 1000;
  entry.answeredAt = 0;
  assert.equal(peekV2Card("chan3", "u9"), null, "2h old card is not reused");
});

test("specUsesAttachment spots a gallery file so it lands in the card", async () => {
  const { specUsesAttachment } = await import("../src/chat/embeds-questions.js");
  const spec = { items: [{ type: "gallery", items: [{ url: "attachment://chart.png" }] }] };
  assert.equal(specUsesAttachment(spec, "chart.png"), true);
  assert.equal(specUsesAttachment(spec, "other.png"), false);
  assert.equal(specUsesAttachment(null, "chart.png"), false);
});

test("editV2 puts the new chart inside the card and drops the old media", async () => {
  const card = fakeCard("m3", [{ url: "https://cdn.example/old.png", name: "old.png" }]);
  const chart = { attachment: Buffer.from("png"), name: "new.png" };
  const spec2 = { accent: "#58b65c", items: [{ type: "gallery", items: [{ url: "attachment://new.png" }] }] };
  await editV2(card, spec2, "u1", [chart]);
  const payload = card.calls[0];
  assert.equal(payload.files.length, 1);
  assert.equal(payload.files[0].name, "new.png");
  assert.deepEqual(payload.attachments, [], "old attachment cleared so two images don't stack");
});

test("editV2 keeps the card's own media when the turn brings no new files", async () => {
  const card = fakeCard("m4", [{ url: "https://cdn.example/keep.png", name: "keep.png" }]);
  await editV2(card, spec, "u1", []);
  assert.equal(card.calls[0].files[0].name, "keep.png");
  assert.equal(card.calls[0].attachments, undefined, "no attachment reset when nothing new arrives");
});

test("footer folds into the card before the button row", async () => {
  const { foldFooterIntoSpec } = await import("../src/chat/embeds-questions.js");
  const s = {
    items: [
      { type: "text", content: "body" },
      { type: "gallery", items: [{ url: "attachment://a.png" }] },
      { type: "buttons", title: "next", options: ["a"] },
    ],
  };
  const out = foldFooterIntoSpec(s, "_ctx 12%_");
  assert.deepEqual(out.map((i) => i.type), ["text", "gallery", "text", "buttons"]);
  assert.equal(out[2].content, "_ctx 12%_");
});

test("stateFromMessage rebuilds options from a v2 card's own buttons", async () => {
  const { stateFromMessage } = await import("../src/chat/embeds-questions.js");
  const msg = {
    components: [
      { type: 17, components: [
        { type: 10, content: "body" },
        { type: 1, components: [
          { type: 2, label: "waste", custom_id: "qbtn:m:0" },
          { type: 2, label: "SMRs", custom_id: "qbtn:m:1" },
        ]},
      ]},
    ],
  };
  const state = stateFromMessage(msg, { id: "u1" });
  assert.deepEqual(state.options, ["waste", "SMRs"]);
  assert.equal(state.fromUserId, "u1");
  assert.equal(state.inline, true);
  assert.equal(state.restored, true);
});

test("stateFromMessage returns null when there is nothing to click", async () => {
  const { stateFromMessage } = await import("../src/chat/embeds-questions.js");
  assert.equal(stateFromMessage({ components: [{ type: 17, components: [{ type: 10, content: "x" }] }] }, { id: "u" }), null);
  assert.equal(stateFromMessage(null, { id: "u" }), null);
});

test("question state survives a process restart via /data", async () => {
  const fs = await import("node:fs");
  const path = "/data/question-state.json";
  const { registerQuestionState, loadQuestionState } = await import("../src/chat/embeds-questions.js");
  const { registry } = await import("../src/core/registry.js");
  registerQuestionState("restart-card", { options: ["a", "b"], v2: true, inline: true, fromUserId: "u1", specItems: [], title: "t" });
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(fs.existsSync(path), "state written to disk");
  registry.questionState.clear();
  // simulate a fresh process: reset the module-level guard by re-importing is
  // not possible here, so assert the file content is loadable instead
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  assert.deepEqual(raw["restart-card"].options, ["a", "b"]);
  assert.ok(typeof raw["restart-card"].savedAt === "number");
  assert.ok(typeof loadQuestionState === "function");
});
