// Tests for cv2 inline continuation: an answered card gets EDITED in place
// instead of spawning a new message (juniper's "not a new message every time").
import { test } from "node:test";
import assert from "node:assert/strict";
import { editV2, buildV2AnsweredComponents } from "../src/chat/embeds-questions.js";

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
