// Shared scratch layout for the exact GPU prefix implementation.
// Operator crossover measurements include the fractional 117 drag radius.
// This is a cost policy; per-line exactness and resource proofs still apply.
export const PREFIX_MIN_RADIUS = 32
export const PREFIX_BYTES = 3275776
export const RESULT_BYTES = 901120
export const METADATA_BYTES = 16384
export const READBACK_BYTES = 1024
export function prefixBandSize(length: number, maxBandLines = 255, outputLength = length) {
  if (![length, outputLength].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 16384)) return 0
  return Math.min(Math.floor(PREFIX_BYTES / (32 * (length + 1))),
    Math.floor(RESULT_BYTES / (8 * outputLength)), Math.floor((METADATA_BYTES - 16) / 16), maxBandLines)
}
/** Three stored RGB values plus a validity mask occupy two vec2<u32> slots
 * per output pixel. Prefix sums/moments and the total 4 MiB allocation stay
 * unchanged; only the result plane uses the actual cropped output length. */
export function prefixRgbBandSize(length: number, outputLength: number, maxBandLines = 255) {
  if (![length, outputLength, maxBandLines].every(Number.isSafeInteger) || length < 1 || length > 16384 ||
      outputLength < 1 || outputLength > 16384 || maxBandLines < 1) return 0
  return Math.min(Math.floor(PREFIX_BYTES / (32 * (length + 1))),
    Math.floor(RESULT_BYTES / (16 * outputLength)), Math.floor((METADATA_BYTES - 16) / 16), maxBandLines)
}
/** Keep the established strip memory ceiling while avoiding a nearly-empty
 * extra prefix band at the end of every source strip. No source support or
 * filtered-axis length changes, hence line exponent/rounding proofs are shared. */
export function prefixAlignedStrip(length: number, limit = 64) {
  const band = prefixBandSize(length)
  return band > 0 && band <= limit ? Math.floor(limit / band) * band : limit
}
/** The RGB result layout uses 16 bytes per actual output pixel. Align source
 * strips to that same dispatch bound without exceeding the old 64-row cap. */
export function prefixAlignedRgbStrip(length: number, outputLength: number, limit = 64) {
  const band = prefixRgbBandSize(length, outputLength)
  return band > 0 && band <= limit ? Math.floor(limit / band) * band : limit
}
