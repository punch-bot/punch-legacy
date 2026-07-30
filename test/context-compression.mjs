import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTO_COMPRESS_MAX_PERCENT,
  AUTO_COMPRESS_MIN_PERCENT,
  validateAutoCompressThreshold,
} from "../src/context-compression.js";

test("auto-compress accepts disabled and documented thresholds", () => {
  assert.equal(validateAutoCompressThreshold(0), 0);
  assert.equal(validateAutoCompressThreshold(AUTO_COMPRESS_MIN_PERCENT), AUTO_COMPRESS_MIN_PERCENT);
  assert.equal(validateAutoCompressThreshold(AUTO_COMPRESS_MAX_PERCENT), AUTO_COMPRESS_MAX_PERCENT);
});

test("auto-compress rejects unsupported threshold values", () => {
  for (const value of [-1, 1, 49, 76, 50.5, NaN]) {
    assert.throws(() => validateAutoCompressThreshold(value), RangeError);
  }
});
