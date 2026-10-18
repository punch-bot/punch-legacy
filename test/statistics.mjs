import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "punch-stats-"));
process.env.DATA_DIR = dataDir;

const stateUrl = new URL("../src/state.js", import.meta.url);
stateUrl.searchParams.set("test", `${Date.now()}-${Math.random()}`);
const statisticsUrl = new URL("../src/statistics.js", import.meta.url);
statisticsUrl.searchParams.set("test", `${Date.now()}-${Math.random()}`);

const state = await import(stateUrl.href);
const statistics = await import(statisticsUrl.href);

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

test("getUsageStatistics aggregates messages, tokens, and periods", async () => {
  const now = Date.now();
  const userId = "user-123";

  state.recordActivity({
    userId,
    type: "reactive",
    status: "success",
    duration: 2000,
    cost: 0.0025,
    tokens: { input: 1000, output: 250, reasoning: 50, cacheRead: 100, cacheWrite: 0, total: 1400 },
  });

  state.recordActivity({
    userId,
    type: "heartbeat",
    routineId: "hb1",
    status: "success",
    duration: 5000,
    cost: 0.001,
    tokens: { input: 500, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 600 },
  });

  state.recordActivity({
    userId,
    type: "reactive",
    routineId: "routine1",
    status: "error",
    duration: 1000,
    tokens: { input: 200, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 200 },
  });

  state.recordActivity({
    userId: "other-user",
    type: "reactive",
    status: "success",
    tokens: { input: 9999, output: 9999, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 19998 },
  });

  const week = state.getUsageStatistics(userId, "week", now);
  assert.equal(week.userMessages, 1);
  assert.equal(week.automations, 2);
  assert.equal(week.totalTurns, 3);
  assert.equal(week.successfulTurns, 2);
  assert.equal(week.failedTurns, 1);
  assert.equal(week.tokens.total, 2200);
  assert.equal(week.totalCost, 0.0035);
  assert.equal(week.avgDurationMs, 2667);

  const empty = state.getUsageStatistics("nobody-here", "week", now);
  assert.equal(empty.totalTurns, 0);
  assert.equal(empty.tokens.total, 0);

  const fields = statistics.tokenFieldsFromAgent({
    cost: 0.01,
    tokenUsage: {
      input: 10,
      output: 20,
      reasoning: 5,
      cache: { read: 3, write: 2 },
    },
  });
  assert.equal(fields.cost, 0.01);
  assert.equal(fields.tokens.total, 40);

  assert.equal(statistics.formatTokenCount(1500), "1.5k");
  assert.equal(statistics.formatTokenCount(2_500_000), "2.5M");
  assert.equal(statistics.parseStatisticsButtonCustomId("stats:month:user-123").period, "month");
  assert.equal(statistics.parseStatisticsButtonCustomId("stats:bad:user-123"), null);
});

test("getUsageStatistics counts messages steered into a turn", () => {
  const userId = "user-steered";
  state.recordActivity({ userId, type: "reactive", status: "success", messages: 3 });
  state.recordActivity({ userId, type: "reactive", status: "success" });
  const stats = state.getUsageStatistics(userId, "week");
  assert.equal(stats.userMessages, 4);
  assert.equal(stats.totalTurns, 2);
});
