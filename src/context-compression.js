export const AUTO_COMPRESS_MIN_PERCENT = 50;
export const AUTO_COMPRESS_MAX_PERCENT = 75;

export function validateAutoCompressThreshold(value) {
  if (!Number.isInteger(value) || (value !== 0 && (value < AUTO_COMPRESS_MIN_PERCENT || value > AUTO_COMPRESS_MAX_PERCENT))) {
    throw new RangeError(`Auto-compress threshold must be 0 or ${AUTO_COMPRESS_MIN_PERCENT}-${AUTO_COMPRESS_MAX_PERCENT}.`);
  }
  return value;
}
