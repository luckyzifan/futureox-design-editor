// Shared scratch layout for the exact GPU prefix implementation.
export const PREFIX_BYTES = 3275776
export const RESULT_BYTES = 901120
export const METADATA_BYTES = 16384
export const READBACK_BYTES = 1024
export function prefixBandSize(length: number, maxBandLines = 255) {
  if (!Number.isSafeInteger(length) || length < 1 || length > 16384) return 0
  return Math.min(Math.floor(PREFIX_BYTES / (32 * (length + 1))),
    Math.floor(RESULT_BYTES / (8 * length)), Math.floor((METADATA_BYTES - 16) / 16), maxBandLines)
}
/** Keep the established strip memory ceiling while avoiding a nearly-empty
 * extra prefix band at the end of every source strip. No source support or
 * filtered-axis length changes, hence line exponent/rounding proofs are shared. */
export function prefixAlignedStrip(length: number, limit = 64) {
  const band = prefixBandSize(length)
  return band > 0 && band <= limit ? Math.floor(limit / band) * band : limit
}
