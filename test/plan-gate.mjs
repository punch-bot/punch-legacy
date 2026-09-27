import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "punch-plangate-"));
process.env.DATA_DIR = dataDir;
const planGateUrl = new URL("../src/plan-gate.js", import.meta.url);
planGateUrl.searchParams.set("test", `${Date.now()}-${Math.random()}`);
const planGate = await import(planGateUrl.href);
const store = await import("../src/memory.js");

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const base = { userId: "u1", sandboxName: "ember", summary: "rename the thing", steps: ["find it", "rename it"], origin: "user" };

test("confirm mode parks the plan as pending", () => {
  planGate.resetPlanGateForTests();
  store.patchUserSettings("u1", { planGate: "confirm" });
  const result = planGate.submitPlanProposal({ ...base, channelId: "c1" });
  assert.equal(result.decision, "pending");
  assert.ok(result.planId.startsWith("pl_"));
  const pending = planGate.getPending(result.planId);
  assert.equal(pending.status, "pending");
  assert.equal(pending.summary, "rename the thing");
  assert.equal(pending.channelId, "c1");
  const stored = JSON.parse(readFileSync(join(dataDir, "pending_plans.json"), "utf8"));
  assert.equal(stored[result.planId].userId, "u1");
});

test("auto mode approves without asking; a2a origin still requires approval", () => {
  planGate.resetPlanGateForTests();
  store.patchUserSettings("u2", { planGate: "auto" });
  const approved = planGate.submitPlanProposal({ ...base, userId: "u2" });
  assert.equal(approved.decision, "approved");
  assert.equal(planGate.getPending(approved.planId).status, "approved");

  const a2a = planGate.submitPlanProposal({ ...base, userId: "u2", origin: "a2a:ember" });
  assert.equal(a2a.decision, "pending");
  assert.equal(planGate.getPending(a2a.planId).origin, "a2a:ember");
});

test("pending cap denies a runaway proposer", () => {
  planGate.resetPlanGateForTests();
  store.patchUserSettings("u3", { planGate: "confirm" });
  for (let i = 0; i < planGate.PLAN_MAX_PENDING_PER_USER; i += 1) {
    assert.equal(planGate.submitPlanProposal({ ...base, userId: "u3", summary: `plan ${i}` }).decision, "pending");
  }
  const over = planGate.submitPlanProposal({ ...base, userId: "u3", summary: "one too many" });
  assert.equal(over.decision, "denied");
  assert.match(over.reason, /pending/);
});

test("rate limit trips after PLAN_RATE_MAX proposals in the window", () => {
  planGate.resetPlanGateForTests();
  store.patchUserSettings("u4", { planGate: "auto" });
  for (let i = 0; i < planGate.PLAN_RATE_MAX; i += 1) {
    assert.equal(planGate.submitPlanProposal({ ...base, userId: "u4" }).decision, "approved");
  }
  const blocked = planGate.submitPlanProposal({ ...base, userId: "u4" });
  assert.equal(blocked.decision, "denied");
  assert.match(blocked.reason, /rate limit/);
});

test("deny queues a one-shot notice for the next turn preamble", () => {
  planGate.resetPlanGateForTests();
  store.patchUserSettings("u5", { planGate: "confirm" });
  const { planId } = planGate.submitPlanProposal({ ...base, userId: "u5" });
  const resolved = planGate.resolvePlan(planId, { status: "denied" });
  assert.equal(resolved.status, "denied");
  const notices = planGate.consumeDeniedNotices("u5");
  assert.equal(notices.length, 1);
  assert.equal(notices[0].planId, planId);
  assert.deepEqual(planGate.consumeDeniedNotices("u5"), []);
});

test("expired plans prune on read and click-through returns nothing", () => {
  planGate.resetPlanGateForTests();
  store.patchUserSettings("u6", { planGate: "confirm" });
  const { planId } = planGate.submitPlanProposal({ ...base, userId: "u6" });
  planGate.updatePending(planId, { createdAt: Date.now() - planGate.PLAN_TTL_MS - 1 });
  assert.equal(planGate.getPending(planId), null);
});

test("metrics track proposed/approved/denied", () => {
  planGate.resetPlanGateForTests();
  store.patchUserSettings("u7", { planGate: "confirm" });
  const p1 = planGate.submitPlanProposal({ ...base, userId: "u7" });
  planGate.resolvePlan(p1.planId, { status: "approved" });
  const p2 = planGate.submitPlanProposal({ ...base, userId: "u7" });
  planGate.resolvePlan(p2.planId, { status: "denied" });
  const stats = planGate.getPlanGateStats();
  assert.equal(stats.proposed, 2);
  assert.equal(stats.approved, 1);
  assert.equal(stats.denied, 1);
  assert.equal(stats.pendingNow, 0);
});
