import { expect, test } from 'vitest'
import { rational_tent_kernel_rgba } from '../../generated/design-kernel/design_kernel'
import shader from './texture-prefix.wgsl?raw'

type Kernel = { reach: number; interior: number; denominator: bigint; coefficients: bigint[] }
const signedLimit = 1n << 127n
const abs = (value: bigint) => value < 0n ? -value : value
const high = (value: bigint) => value ? value.toString(2).length - 1 : -1
function kernel(radius: number): Kernel {
  const bytes = rational_tent_kernel_rgba(radius), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const words = view.getUint32(0, true), reach = view.getUint32(8, true)
  const value = (index: number) => {
    let n = 0n
    for (let i = words - 1; i >= 0; i--) n = n << 32n | BigInt(view.getUint32((4 + words * index + i) * 4, true))
    return n
  }
  return { reach, interior: Math.floor(radius) - 1, denominator: value(0),
    coefficients: Array.from({ length: reach + 1 }, (_, distance) => value(1 + distance)) }
}
function gate(k: Kernel, length: number, span: number, windowed: boolean) {
  const scope = windowed ? Math.min(length, 2 * k.reach + 1) : length
  const bits = Math.floor(Math.log2(scope)) + 1
  const weighted = Math.max(high(k.coefficients[0]) + bits + 3,
    high(k.coefficients[1] - k.coefficients[2]) + 2 * bits + 4)
  return high(k.denominator) <= 95 && span <= 40 && 24 + span + weighted + 3 <= 123
}
function maxSpan(k: Kernel, length: number, windowed: boolean) {
  return Array.from({ length: 41 }, (_, i) => i).filter(span => gate(k, length, span, windowed)).at(-1)
}
function bounded(value: bigint, stage: string) {
  if (abs(value) >= signedLimit) throw Error(`${stage} exceeds signed128: ${value}`)
  return value
}
function verifyLine(values: bigint[], k: Kernel) {
  const length = values.length, sums = [0n], moments = [0n]
  for (let i = 0; i < length; i++) {
    sums.push(bounded(sums[i] + values[i], 'unweighted prefix sum'))
    moments.push(bounded(moments[i] + bounded(values[i] * BigInt(i), 'sample moment'), 'unweighted prefix moment'))
  }
  const positions = [...new Set([0, 1, k.reach - 1, k.reach, Math.floor(length / 2), length - k.reach, length - 2, length - 1])]
    .filter(x => x >= 0 && x < length)
  for (const x of positions) {
    const lo = Math.max(0, x - k.interior), hi = Math.min(length, x + k.interior + 1)
    const left = bounded(sums[x] - sums[lo], 'left sum'), right = bounded(sums[hi] - sums[x + 1], 'right sum')
    const combined = bounded(left + right, 'window sum')
    const leftDistance = bounded(bounded(left * BigInt(x), 'absolute-index left product') -
      bounded(moments[x] - moments[lo], 'left moment difference'), 'left distance difference')
    const rightDistance = bounded(bounded(moments[hi] - moments[x + 1], 'right moment difference') -
      bounded(right * BigInt(x), 'absolute-index right product'), 'right distance difference')
    const distance = bounded(leftDistance + rightDistance, 'window distance')
    const center = k.coefficients[0], slope = k.coefficients[1] - k.coefficients[2]
    const intercept = bounded(k.coefficients[1] + slope, 'intercept')
    const centerProduct = bounded(values[x] * center, 'weighted center')
    const sumProduct = bounded(combined * intercept, 'weighted window sum')
    const distanceProduct = bounded(distance * slope, 'weighted window distance')
    let actual = bounded(centerProduct + bounded(sumProduct - distanceProduct, 'weighted difference'), 'center plus interior')
    for (let d = k.interior + 1; d <= k.reach; d++) {
      const pair = bounded((values[x - d] ?? 0n) + (values[x + d] ?? 0n), 'tail pair')
      actual = bounded(actual + bounded(pair * k.coefficients[d], 'weighted tail'), 'tail accumulation')
    }
    // Independent direct convolution over native rational coefficients.
    let expected = 0n
    for (let at = Math.max(0, x - k.reach); at <= Math.min(length - 1, x + k.reach); at++)
      expected += values[at] * k.coefficients[Math.abs(at - x)]
    expect(actual).toBe(expected)
  }
}

test('production gate weights only complete support while keeping all prior rejection and rounding checks', () => {
  expect(shader).toContain('let windowLength=min(length,2u*rfLoad(2u)+1u);let lineBits=i32(bsHigh(windowLength))+1;')
  expect(shader).toContain('if(span>40u){reason=3u;}')
  expect(shader).toContain('if(rfLoad(0u)>4u||prefix_high(prefixDenominator())>95){reason=4u;}')
  expect(shader).toContain('if(24+i32(span)+weightedBits+3>123){reason=5u;}')
  expect(shader).toContain('return prefix_round_wide(numerator,prefixDenominator(),quantum);')
  expect(shader).toContain('return vec4<f32>(exactFilterChannel(p,direction,PREFIX_CHANNEL));')
})
test('native 117 drag kernel gains eight exact exponent-span bits, high zoom remains unchanged', () => {
  const drag = kernel(38.25948715209961)
  expect(drag.reach).toBe(39); expect(high(drag.denominator) + 1).toBe(68)
  expect([maxSpan(drag, 1108, false), maxSpan(drag, 1108, true)]).toEqual([14, 22])
  expect(gate(drag, 1108, 23, true)).toBe(false)
  const zoom = kernel(1224.3035888671875)
  expect([maxSpan(zoom, 3484, false), maxSpan(zoom, 3484, true)]).toEqual([27, 27])
})
test('whole-line unweighted arithmetic remains bounded without the rational weighted admission', () => {
  const n = 16384n, magnitude = (1n << 64n) - 1n
  const sum = n * magnitude, moment = n * (n - 1n) / 2n * magnitude
  const absoluteIndexProduct = (n - 1n) * sum
  expect(sum < 1n << 78n).toBe(true)
  expect(moment < 1n << 91n).toBe(true)
  expect(absoluteIndexProduct < 1n << 92n).toBe(true)
  // Even a deliberately looser triangle inequality for every subtraction
  // and both distance terms stays far inside signed128 before weighting.
  expect(2n * (absoluteIndexProduct + 2n * moment) < 1n << 95n).toBe(true)
})
test.each([3.125, 32.25, 38.25948715209961, 48.5, 511.75, 513, 1224.3035888671875, 2048])(
  'native tent radius %s obeys monotone coefficients, complete tails and tightened weighted bound', radius => {
    const k = kernel(radius)
    expect(k.coefficients.every((c, i) => c >= 0n && (!i || c <= k.coefficients[i - 1]))).toBe(true)
    expect(k.reach - k.interior).toBeGreaterThanOrEqual(1)
    expect(k.reach - k.interior).toBeLessThanOrEqual(2)
    const c0 = k.coefficients[0], slope = k.coefficients[1] - k.coefficients[2]
    expect(k.coefficients[1] + slope <= 2n * c0).toBe(true)
    for (const length of [1, 2, 79, 1108, 16384]) {
      const span = maxSpan(k, length, true)
      if (span === undefined) continue // Existing denominator gate remains authoritative.
      const magnitude = (1n << BigInt(24 + span)) - 1n, count = BigInt(Math.min(length, 2 * k.reach + 1))
      // Bounds include all signs/cancellation and all possible nonzero taps.
      const centerSumTails = 3n * count * magnitude * c0
      const distanceProduct = count * count * magnitude * slope
      expect(centerSumTails + distanceProduct < 1n << 123n).toBe(true)
      for (const pattern of [0, 1, 2, 3]) {
        let state = 0x53cba14f
        const values = Array.from({ length }, (_, i) => {
          if (pattern === 0) return magnitude
          if (pattern === 1) return -magnitude
          if (pattern === 2) return i % 2 ? magnitude : -magnitude
          state ^= state << 13; state ^= state >>> 17; state ^= state << 5
          const fraction = BigInt(state >>> 0)
          return (i % 3 ? 1n : -1n) * (magnitude * fraction / 0xffffffffn)
        })
        verifyLine(values, k)
      }
    }
  },
)
