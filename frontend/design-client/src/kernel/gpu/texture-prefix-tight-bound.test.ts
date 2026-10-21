import { expect, test } from 'vitest'
import { rational_tent_kernel_rgba } from '../../generated/design-kernel/design_kernel'
import shader from './texture-prefix.wgsl?raw'
import { certifyPrefixRationalBound, prefixRationalBoundBits, type PrefixRationalBoundCertificate } from './prefix-preflight'

type Kernel = { cw: number; denominator: bigint; reach: number; interior: number; radius: number; coefficients: bigint[] }
const abs = (n: bigint) => n < 0n ? -n : n
const high = (n: bigint) => n ? n.toString(2).length - 1 : -1
function native(radius: number): Kernel {
  const bytes = rational_tent_kernel_rgba(radius), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const cw = view.getUint32(0, true), reach = view.getUint32(8, true)
  const value = (at: number) => {
    let n = 0n
    for (let word = cw - 1; word >= 0; word--) n = n << 32n | BigInt(view.getUint32((4 + cw * at + word) * 4, true))
    return n
  }
  return { cw, reach, radius, interior: Math.floor(radius) - 1, denominator: value(0),
    coefficients: Array.from({ length: reach + 1 }, (_, i) => value(i + 1)) }
}
function encode(k: Kernel) {
  const bytes = new Uint8Array(4 * (4 + k.cw * (k.reach + 2))), view = new DataView(bytes.buffer)
  view.setUint32(0, k.cw, true); view.setUint32(4, Math.ceil((high(k.denominator) + 1 + 278) / 32), true)
  view.setUint32(8, k.reach, true)
  for (let at = 0; at < k.reach + 2; at++) {
    const value = at === 0 ? k.denominator : k.coefficients[at - 1] ?? 0n
    for (let word = 0; word < k.cw; word++) view.setUint32((4 + k.cw * at + word) * 4, Number(value >> BigInt(word * 32) & 0xffffffffn), true)
  }
  return bytes
}
const certificates = new WeakMap<Kernel, PrefixRationalBoundCertificate | undefined>()
function boundBits(k: Kernel, _length?: number) {
  if (!certificates.has(k)) certificates.set(k, certifyPrefixRationalBound(encode(k)))
  const bits = prefixRationalBoundBits(certificates.get(k), k.radius)
  return { bits, valid: bits > 0 ? 1 : 0 }
}
function oracleBound(k: Kernel, length = Infinity) {
  const c0 = k.coefficients[0], slope = k.coefficients[1] - k.coefficients[2], intercept = k.coefficients[1] + slope
  const n = BigInt(Math.min(k.interior, length - 1))
  const tails = k.coefficients.slice(k.interior + 1, k.reach + 1).reduce((sum, c) => sum + c, 0n)
  return c0 + 2n * n * intercept + n * (n + 1n) * slope + 2n * tails
}
function gate(k: Kernel, length: number, span: number) {
  const bound = boundBits(k, length)
  return !!bound.valid && span <= 40 && 24 + span + bound.bits <= 123
}
function maximumSpan(k: Kernel, length: number) {
  return Array.from({ length: 41 }, (_, i) => i).filter(span => gate(k, length, span)).at(-1)
}
test('GPU consumes only certified CPU bits and otherwise retains the old window branch', () => {
  expect(shader).not.toContain('fn prefixRationalBoundBits(')
  expect(shader).toContain('let boundBits=u(49u).w;')
  expect(shader).toContain('if(PREFIX_TIGHT_BOUND&&boundBits>0.&&boundBits<=120.&&floor(boundBits)==boundBits){')
  expect(shader).toContain('if(24+i32(span)+i32(boundBits)>123){reason=5u;}')
  expect(shader).toContain('if(24+i32(span)+weightedBits+3>123){reason=5u;}')
  expect(shader).toContain('if(span>40u){reason=3u;}')
  expect(shader).toContain('return prefix_round_wide(numerator,prefixDenominator(),quantum);')
})
test('actual native 117 coefficients admit the 30/35 boundaries and reject the next span', () => {
  const low = native(38.25948715209961), highZoom = native(1224.3035888671875)
  expect([low.interior, low.reach]).toEqual([37, 39])
  expect([highZoom.interior, highZoom.reach]).toEqual([1223, 1225])
  expect(oracleBound(low, 1108)).toBe(462154532446520475648n)
  expect(oracleBound(highZoom, 3484)).toBe(14819734306164621312n)
  expect([boundBits(low, 1108).bits, maximumSpan(low, 1108)]).toEqual([69, 30])
  expect([boundBits(highZoom, 3484).bits, maximumSpan(highZoom, 3484)]).toEqual([64, 35])
  for (const span of [23, 29, 30]) expect(gate(low, 1108, span)).toBe(true)
  expect(gate(low, 1108, 31)).toBe(false)
  for (const span of [28, 34, 35]) expect(gate(highZoom, 3484, span)).toBe(true)
  expect(gate(highZoom, 3484, 36)).toBe(false)
})
test('CPU packet authority is opaque, immutable, offset-safe and independent of later input mutations', () => {
  const bytes = rational_tent_kernel_rgba(38.25948715209961), backing = new Uint8Array(bytes.length + 3)
  backing.set(bytes, 1)
  const view = backing.subarray(1, 1 + bytes.length), proof = certifyPrefixRationalBound(view)!
  expect(proof).toBeDefined(); expect(Object.isFrozen(proof)).toBe(true); expect(Object.keys(proof)).toEqual([])
  expect(prefixRationalBoundBits(proof, 38.25948715209961)).toBe(69)
  expect(prefixRationalBoundBits({ ...proof }, 38.25948715209961)).toBe(0)
  expect(prefixRationalBoundBits(structuredClone(proof), 38.25948715209961)).toBe(0)
  expect(prefixRationalBoundBits(undefined, 38.25948715209961)).toBe(0)
  view.fill(0)
  expect(certifyPrefixRationalBound(view)).toBeUndefined()
  // The private certificate still describes the already-uploaded original
  // bytes, not the mutable caller array. Texture writes revoke it in the driver.
  for (let i = 0; i < 100; i++) expect(prefixRationalBoundBits(proof, 38.25948715209961)).toBe(69)
})
test('wire parser rejects concurrent sources, truncation, extra words and malformed native headers', () => {
  const bytes = rational_tent_kernel_rgba(38.25948715209961)
  const shared = new Uint8Array(new SharedArrayBuffer(bytes.length)); shared.set(bytes)
  expect(certifyPrefixRationalBound(shared)).toBeUndefined()
  for (let size = 0; size < bytes.length; size++) expect(certifyPrefixRationalBound(bytes.subarray(0, size))).toBeUndefined()
  const padded = new Uint8Array(bytes.length + 4); padded.set(bytes)
  expect(certifyPrefixRationalBound(padded)).toBeUndefined()
  for (const [offset, value] of [[0, 0], [0, 5], [4, 0], [4, 44], [8, 0], [8, 2], [8, 2049], [12, 1]]) {
    const changed = bytes.slice(); new DataView(changed.buffer).setUint32(offset, value, true)
    expect(certifyPrefixRationalBound(changed)).toBeUndefined()
  }
  const k = native(38.25948715209961)
  const extraWord = certifyPrefixRationalBound(encode({ ...k, cw: 4 }))
  expect(prefixRationalBoundBits(extraWord, k.radius)).toBe(69) // Leading zero word is still within CW<=4.
  expect(certifyPrefixRationalBound(encode({ ...k, cw: 4, denominator: 1n << 96n }))).toBeUndefined()
  const corruptMiddle = { ...k, coefficients: k.coefficients.map((value, i) => i === 10 ? k.denominator + 1n : value) }
  expect(certifyPrefixRationalBound(encode(corruptMiddle))).toBeUndefined()
})
test('malformed metadata and oversized or decreasing coefficients never construct an unsafe B', () => {
  const k = native(38.25948715209961)
  const bad = [
    { ...k, cw: 0 }, { ...k, cw: 5 }, { ...k, denominator: 0n }, { ...k, denominator: 1n << 96n },
    { ...k, reach: 2049 }, { ...k, reach: k.interior - 1 }, { ...k, reach: k.interior + 5 },
    { ...k, coefficients: [0n, ...k.coefficients.slice(1)] },
    ...[0, 1, 2, k.reach].map(at => ({ ...k, coefficients: k.coefficients.map((c, i) => i === at ? k.denominator + 1n : c) })),
    { ...k, coefficients: k.coefficients.map((c, i) => i === 1 ? 0n : c) },
  ]
  for (const invalid of bad) expect(boundBits(invalid, 1108).valid).toBe(0)
  const certificate = certifyPrefixRationalBound(encode(k))!
  for (const radius of [NaN, Infinity, -1, 0, 2.5, 2049, 37.5, 39.1])
    expect(prefixRationalBoundBits(certificate, radius)).toBe(0)
})
test('the worst permitted metadata still constructs B below 2^120', () => {
  const d = (1n << 96n) - 1n, coefficients = Array<bigint>(2049).fill(d)
  coefficients[2] = 0n
  const k = { cw: 3, denominator: d, reach: 2048, interior: 2046, radius: 2047.5, coefficients }
  const result = boundBits(k, 16384)
  expect(result.valid).toBe(1)
  expect(result.bits).toBe(high(oracleBound(k, 16384)) + 1)
  expect(oracleBound(k)).toBeLessThan(1n << 120n)
  // The construction proof conservatively permits four tails even though
  // native ceil/floor radius choices here need only one or two.
  expect(oracleBound({ ...k, interior: 2044 })).toBeLessThan(1n << 120n)
  expect(gate(k, 16384, 0)).toBe(false)
})
function checkLine(k: Kernel, length: number, span: number, pattern: number) {
  const M = 1n << BigInt(24 + span), magnitude = M - 1n, B = oracleBound(k)
  const weightedLimit = M * B
  expect(weightedLimit).toBeLessThan(1n << 123n)
  let seed = 0x739ca2b1
  const values = Array.from({ length }, (_, i) => {
    if (pattern === 0) return magnitude
    if (pattern === 1) return -magnitude
    if (pattern === 2) return i % 2 ? magnitude : -magnitude
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
    return (i % 3 ? 1n : -1n) * magnitude * BigInt(seed >>> 0) / 0xffffffffn
  })
  const sums = [0n], moments = [0n]
  const unweighted = (v: bigint) => { if (abs(v) >= 1n << 95n) throw Error('Unweighted intermediate bound'); return v }
  const weighted = (v: bigint) => { if (abs(v) >= weightedLimit) throw Error('Original weighted intermediate exceeds M*B'); return v }
  for (let x = 0; x < length; x++) {
    sums.push(unweighted(sums[x] + values[x])); moments.push(unweighted(moments[x] + unweighted(values[x] * BigInt(x))))
  }
  const C0 = k.coefficients[0], S = k.coefficients[1] - k.coefficients[2], I = k.coefficients[1] + S, D = I - C0
  const points = [...new Set([0, 1, k.interior, k.reach, Math.floor(length / 2), length - k.reach - 1, length - 1])].filter(x => x >= 0 && x < length)
  for (const x of points) {
    const lo = Math.max(0, x - k.interior), hi = Math.min(length, x + k.interior + 1)
    const left = unweighted(sums[x] - sums[lo]), right = unweighted(sums[hi] - sums[x + 1])
    const sum = unweighted(left + right)
    const distances = unweighted(unweighted(unweighted(left * BigInt(x)) - unweighted(moments[x] - moments[lo])) +
      unweighted(unweighted(moments[hi] - moments[x + 1]) - unweighted(right * BigInt(x))))
    const a = weighted(values[x] * C0), b = weighted(sum * I), c = weighted(distances * S)
    let result = weighted(a + weighted(b - c))
    if (D > 0n && D <= C0 && S === 3n * D) {
      const first = (values[x] + sum) * I, second = (values[x] + 3n * distances) * D
      const factorBound = M * (B + 2n * D)
      for (const value of [first, second, first - second]) {
        expect(abs(value)).toBeLessThan(factorBound)
        expect(abs(value)).toBeLessThan(1n << 125n)
      }
      expect(first - second).toBe(result)
    }
    for (let distance = k.interior + 1; distance <= k.reach; distance++) {
      const pair = unweighted((values[x - distance] ?? 0n) + (values[x + distance] ?? 0n))
      result = weighted(result + weighted(pair * k.coefficients[distance]))
    }
    let independent = 0n
    for (let at = Math.max(0, x - k.reach); at <= Math.min(length - 1, x + k.reach); at++)
      independent += values[at] * k.coefficients[Math.abs(at - x)]
    expect(result).toBe(independent)
  }
}
test.each([3.125, 32.25, 38.25948715209961, 48.5, 511.75, 513, 1224.3035888671875, 2048])(
  'native radius %s respects original/factored bounds for signed extremes and full tails', radius => {
    const k = native(radius)
    for (const length of [1, 2, 79, 1108, 3484, 16384]) {
      const actual = boundBits(k, length), expected = oracleBound(k)
      expect(actual.valid).toBe(1); expect(actual.bits).toBe(high(expected) + 1)
      expect(expected).toBeGreaterThanOrEqual(oracleBound(k, length))
      const span = maximumSpan(k, length)
      if (span === undefined) continue
      for (let pattern = 0; pattern < 4; pattern++) checkLine(k, length, span, pattern)
    }
  },
)
