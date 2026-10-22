/** Shadow-alpha-only extension of the integer integrated tent. This is not an
 * alternative RGBA/HDR filter or a replacement for the export implementation. */
export type ByteTentRect = Readonly<{ x: number; y: number; w: number; h: number }>
export type ByteTentOptions = Readonly<{
  radius: number; axis: 0 | 1; source: ByteTentRect; output: ByteTentRect
  /** Two default jobs (the two byte-quantized axes) fit within four MiB. */
  scratchBudgetBytes?: number
}>
export type ByteTentPlan = Readonly<{
  radius: number; axis: 0 | 1; source: ByteTentRect; output: ByteTentRect
  length: number; lines: number; bandLines: number; bands: number
  prefixBytes: number; uniformBytes: number; bytes: number
}>
export const BYTE_TENT_MAX_SCRATCH_BYTES = 4 * 1024 * 1024
export const BYTE_TENT_DEFAULT_SCRATCH_BYTES = 2 * 1024 * 1024

export function planByteTentPrefix(options: ByteTentOptions): ByteTentPlan | undefined {
  const { radius, axis, source, output } = options
  if (!Number.isSafeInteger(radius) || radius < 1 || radius > 2048 || axis !== 0 && axis !== 1) return
  for (const r of [source, output]) {
    if (!r || ![r.x, r.y, r.w, r.h].every(Number.isSafeInteger) ||
        r.w < 1 || r.h < 1 || r.w > 16384 || r.h > 16384 ||
        [r.x, r.y, r.x + r.w, r.y + r.h].some(v => Math.abs(v) + radius + 1 > 1048576)) return
  }
  const budget = options.scratchBudgetBytes ?? BYTE_TENT_DEFAULT_SCRATCH_BYTES
  if (!Number.isSafeInteger(budget) || budget < 0 || budget > BYTE_TENT_MAX_SCRATCH_BYTES) return
  const length = axis === 0 ? source.w : source.h, lines = axis === 0 ? output.h : output.w
  for (let bandLines = Math.min(lines, 255); bandLines >= 1; bandLines--) {
    const bands = Math.ceil(lines / bandLines)
    const prefixBytes = length * bandLines * 16, uniformBytes = bands * 256
    const bytes = prefixBytes + uniformBytes
    if (bytes <= budget) return Object.freeze({ radius, axis, source: Object.freeze({ ...source }),
      output: Object.freeze({ ...output }), length, lines, bandLines, bands, prefixBytes, uniformBytes, bytes })
  }
}

export function byteTentNumerator(alpha: ArrayLike<number>, center: number, radius: number): bigint {
  if (!Number.isSafeInteger(center) || !Number.isSafeInteger(radius) || radius < 1 || radius > 2048)
    throw Error('Invalid integer tent oracle input')
  let numerator = 0n
  for (let tap = -radius; tap <= radius; tap++) {
    const at = center + tap
    if (at < 0 || at >= alpha.length) continue
    const value = alpha[at]
    if (!Number.isSafeInteger(value) || value < 0 || value > 255) throw Error('Expected byte alpha')
    const distance = Math.abs(tap)
    const weight = distance === 0 ? 6 * radius - 2 : distance === radius ? 1 : 6 * (radius - distance)
    numerator += BigInt(value) * BigInt(weight)
  }
  return numerator
}
export function byteTentRoundEven(numerator: bigint, denominator: bigint): number {
  if (numerator < 0n || denominator <= 0n) throw Error('Invalid unsigned quotient')
  const q = numerator / denominator, r = numerator % denominator
  return Number(q + (r * 2n > denominator || r * 2n === denominator && (q & 1n) !== 0n ? 1n : 0n))
}
/** Direct integer-weight oracle. Deliberately does not use prefix sums. */
export function byteTentOracle(alpha: ArrayLike<number>, center: number, radius: number): number {
  return byteTentRoundEven(byteTentNumerator(alpha, center, radius), 6n * BigInt(radius) ** 2n)
}
/** BigInt model of the GPU sum/moment identity, kept separate from the direct
 * tap and footprint-integral oracles used to check it. */
export function byteTentPrefixOracle(alpha: ArrayLike<number>, center: number, radius: number): number {
  const sums = [0n], moments = [0n]
  for (let i = 0; i < alpha.length; i++) {
    sums.push(sums[i] + BigInt(alpha[i])); moments.push(moments[i] + BigInt(alpha[i]) * BigInt(i))
  }
  const window = (first: number, last: number) => {
    const lo = Math.max(0, first), hi = Math.min(alpha.length - 1, last)
    return hi < lo ? [0n, 0n] : [sums[hi + 1] - sums[lo], moments[hi + 1] - moments[lo]]
  }
  const left = window(center - radius + 1, center), right = window(center + 1, center + radius - 1)
  const at = (i: number) => i >= 0 && i < alpha.length ? BigInt(alpha[i]) : 0n
  const triangle = left[1] - BigInt(center - radius) * left[0] + BigInt(center + radius) * right[0] - right[1]
  return byteTentRoundEven(6n * triangle - 2n * at(center) + at(center - radius) + at(center + radius),
    6n * BigInt(radius) ** 2n)
}
/** Independent exact rational footprint integral: twice-integrate the tent's
 * positive-part cubic at the source/output pixel boundaries. No kernel table,
 * prefix sum or special centre/edge integer coefficient is used. */
export function byteTentRationalOracle(alpha: ArrayLike<number>, center: number, radius: number): number {
  const positiveCube = (n: bigint) => n > 0n ? n ** 3n : 0n
  const primitive6 = (x: bigint, r: bigint) => positiveCube(x + r) - 2n * positiveCube(x) + positiveCube(x - r)
  const r = BigInt(radius)
  let numerator = 0n
  for (let at = Math.max(0, center - radius); at <= Math.min(alpha.length - 1, center + radius); at++) {
    const x = BigInt(at - center)
    const integral = primitive6(x + 1n, r) - 2n * primitive6(x, r) + primitive6(x - 1n, r)
    numerator += BigInt(alpha[at]) * integral
  }
  return byteTentRoundEven(numerator, 6n * r * r)
}
