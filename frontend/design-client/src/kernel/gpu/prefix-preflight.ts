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

declare const rationalBoundBrand: unique symbol
/** Opaque proof for one actual immutable coefficient upload. The driver owns
 * its association with the texture and must revoke that association on writes. */
export type PrefixRationalBoundCertificate = Readonly<{ [rationalBoundBrand]: true }>
const rationalBounds = new WeakMap<PrefixRationalBoundCertificate, Readonly<{
  reach: number; integerBits: number; fractionalBits: number
}>>()

/** Parse the real little-endian rational packet and compute both possible
 * interior bounds once. No caller-supplied metadata or digest grants authority.
 * The driver scans/uploads these ordinary ArrayBuffer bytes synchronously. */
export function certifyPrefixRationalBound(bytes: Uint8Array): PrefixRationalBoundCertificate | undefined {
  if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer) ||
      bytes.byteLength < 16 || bytes.byteLength % 4 !== 0) return
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const cw = view.getUint32(0, true), accumulatorWords = view.getUint32(4, true), reach = view.getUint32(8, true)
  if (cw < 1 || cw > 4 || reach < 3 || reach > 2048 || view.getUint32(12, true) !== 0 ||
      bytes.byteLength !== 4 * (4 + cw * (reach + 2))) return
  const value = (index: number) => {
    let result = 0n
    for (let word = cw - 1; word >= 0; word--)
      result = result << 32n | BigInt(view.getUint32((4 + cw * index + word) * 4, true))
    return result
  }
  const denominator = value(0)
  if (denominator <= 0n || denominator >= 1n << 96n) return
  const denominatorBits = denominator.toString(2).length
  if (accumulatorWords !== Math.ceil((denominatorBits + 278) / 32)) return
  const coefficients: bigint[] = []
  for (let distance = 0; distance <= reach; distance++) {
    const coefficient = value(distance + 1)
    if (coefficient > denominator) return
    coefficients.push(coefficient)
  }
  const center = coefficients[0], slope = coefficients[1] - coefficients[2]
  if (center === 0n || slope < 0n) return
  const intercept = coefficients[1] + slope
  const bitsFor = (interior: number) => {
    if (interior < 1 || interior > 2048 || reach < interior || reach - interior > 4) return 0
    // n=interior conservatively covers every line length. For short lines
    // this can over-report; it never relies on a caller's output crop.
    const n = BigInt(interior)
    let bound = center + 2n * n * intercept + n * (n + 1n) * slope
    for (let distance = interior + 1; distance <= reach; distance++) bound += 2n * coefficients[distance]
    if (bound <= 0n || bound >= 1n << 120n) return 0
    return bound.toString(2).length
  }
  const integerBits = bitsFor(reach - 1), fractionalBits = bitsFor(reach - 2)
  if (!integerBits || !fractionalBits) return
  const certificate = Object.freeze({}) as PrefixRationalBoundCertificate
  rationalBounds.set(certificate, Object.freeze({ reach, integerBits, fractionalBits }))
  return certificate
}

/** Zero means use the old GPU window gate. Both B values were computed during
 * certification; repeated H/V/strip lookups perform no BigInt work or parsing.
 * Radius chooses the existing native interior definition, not new coefficients. */
export function prefixRationalBoundBits(packet: PrefixRationalBoundCertificate | undefined, originalRadius: number): number {
  const known = packet && rationalBounds.get(packet)
  if (!known || !Number.isFinite(originalRadius) || originalRadius < 3 || originalRadius > 2048 ||
      Math.ceil(originalRadius) !== known.reach) return 0
  const interior = Math.floor(originalRadius) - 1
  if (interior === known.reach - 1) return known.integerBits
  if (interior === known.reach - 2) return known.fractionalBits
  return 0
}
