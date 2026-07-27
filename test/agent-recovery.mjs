import assert from "node:assert/strict";
import { isStuckTurnError } from "../src/agent.js";

assert.equal(isStuckTurnError("pi stalled: no progress for 90s (session stuck)"), true);
assert.equal(isStuckTurnError("pi turn exceeded 1800s ceiling"), true);
assert.equal(isStuckTurnError("pi turn exceeded 300s hard timeout"), true);
assert.equal(isStuckTurnError("turn exceeded 300s hard cap"), true);
assert.equal(isStuckTurnError("aborted"), false);
assert.equal(isStuckTurnError("pi API 500: boom"), false);

console.log("ok: stuck-turn recovery detection");
