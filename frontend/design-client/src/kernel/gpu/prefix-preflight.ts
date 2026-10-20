/** A CPU proof of texture-prefix.wgsl's rational reason 4, not a substitute for
 * shader certification. Unknown/malformed metadata deliberately stays on the
 * old eligibility path. Only immutable rational-tent kernel bytes call this. */
export function prefixRationalUnsupported(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 16 || bytes.byteLength % 4 !== 0) return false
  const words = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = words.getUint32(0, true)
  if (count < 1 || count > (bytes.byteLength - 16) / 4) return false
  // rfLoad(0)>4, or prefix_high(prefixDenominator())>95. For <=4 words
  // only the fourth little-endian word can raise the highest bit above95.
  return count > 4 || count === 4 && words.getUint32(28, true) !== 0
}
