import { expect, test } from 'vitest'
import { certifyExactImageRange, exactImageXTableBuildWgsl, exactImageXTableSampleWgsl,
  imageXTablePlanRange, planExactImageXTable, type ExactImageRange } from './exact-image-x-table'

function fixture() {
  const width = 4, height = 3, imageWidth = 8, imageHeight = 8, span = Math.max(width, height)
  const pixels = new Float32Array(imageWidth * imageHeight * 4).fill(1)
  const range = certifyExactImageRange(pixels)!
  const axes = Array.from({ length: 4 }, (_, sample) => {
    const values = new Float32Array(span * 8)
    for (let x = 0; x < width; x++) values.set([x + 1, (sample + 1) / 8, 1, -1], x * 4)
    for (let y = 0; y < height; y++) values.set([y + 2, (sample + 1) / 8, 1, -1], (span + y) * 4)
    return values
  })
  return { width, height, imageWidth, imageHeight, range, axes, pixels }
}
test('admission keeps all four exact sample phases and only the source rows they read', () => {
  const f = fixture(), plan = planExactImageXTable(f)!
  expect(plan.rowMin).toBe(2); expect(plan.rowCount).toBe(4)
  expect(plan.tableBytes).toBe(4 * 4 * 4 * 3 * 12)
  expect([...plan.uniform]).toEqual([4, 3, 2, 4, 8, 8, 3, 1, 127, 127, 127, 127, 0, 0, 4, 3, 0, 1, 2, 3])
  expect([...plan.x.slice(0, 4)]).toEqual([1, 1, 3, 0])
  expect([...plan.x.slice(4 * 4, 4 * 4 + 4)]).toEqual([1, 1, 2, 0])
  expect([...plan.y.slice(0, 4)]).toEqual([0, 1, 3, 0])
  expect([...plan.y.slice(8, 12)]).toEqual([2, 1, 3, 0])
})
test('fraction metadata admits 36/35-bit denominators without truncating their 24-bit numerators', () => {
  const f = fixture()
  for (const a of f.axes) { a[1] = 2 ** -36; a[4 * 4 + 1] = 2 ** -35 }
  const p = planExactImageXTable(f)!
  expect([p.maxKx, p.maxKy]).toEqual([36, 35])
  expect([...p.x.slice(0, 4)]).toEqual([1, 1, 36, 0])
  expect([...p.y.slice(0, 4)]).toEqual([0, 1, 35, 0])
})
test('signed zeros and one retain their exact endpoint metadata', () => {
  const f = fixture(); f.axes[0][1] = -0; f.axes[0][5] = 1
  const p = planExactImageXTable(f)!
  expect([...p.x.slice(0, 8)]).toEqual([1, 0, 0, 0, 2, 1, 0, 0])
})
test('identical complete X programs share storage while all four independent Y phases survive', () => {
  const f = fixture()
  f.axes[2].set(f.axes[0].subarray(0, f.width * 4))
  f.axes[3].set(f.axes[1].subarray(0, f.width * 4))
  const compact = planExactImageXTable(f)!, original = planExactImageXTable({ ...f, reuseIdenticalX: false })!
  expect(compact.xSampleCount).toBe(2); expect(original.xSampleCount).toBe(4)
  expect(compact.uniform.slice(16)).toEqual(new Uint32Array([0, 1, 0, 1]))
  expect(compact.tableBytes).toBe(original.tableBytes / 2)
  expect(compact.x.byteLength).toBe(original.x.byteLength / 2)
  expect(compact.y).toEqual(original.y)
  expect(compact.y.slice(0, f.height * 4)).not.toEqual(compact.y.slice(2 * f.height * 4, 3 * f.height * 4))
  expect(compact.uniform.slice(0, 16)).toEqual(original.uniform.slice(0, 16))
  expect(imageXTablePlanRange(compact)).toBe(f.range)
})
test('program sharing honors nonadjacent and all-identical sample groups without guessing standard phase order', () => {
  const groups = [[0, 0, 0, 0], [0, 0, 1, 1], [0, 1, 1, 0], [0, 1, 0, 1], [0, 1, 2, 0], [0, 1, 2, 3]]
  for (const mapping of groups) {
    const f = fixture(), originals = f.axes.map(a => a.slice())
    for (let sample = 0; sample < 4; sample++) f.axes[sample].set(originals[mapping[sample]].subarray(0, f.width * 4))
    const p = planExactImageXTable(f)!
    expect([...p.uniform.slice(16)]).toEqual(mapping)
    expect(p.xSampleCount).toBe(new Set(mapping).size)
    for (let sample = 0; sample < 4; sample++) {
      const group = p.uniform[16 + sample]
      for (let x = 0; x < f.width; x++) {
        const at = (group * f.width + x) * 4
        expect(p.x[at]).toBe(f.axes[sample][x * 4])
        expect(p.x[at + 1] / 2 ** p.x[at + 2]).toBe(f.axes[sample][x * 4 + 1])
      }
    }
  }
})
test.each(['last cell', 'last fraction ULP', 'endpoint'] as const)(
  'an X difference at the final pixel prevents sharing: %s', kind => {
    const f = fixture()
    for (let sample = 1; sample < 4; sample++) f.axes[sample].set(f.axes[0].subarray(0, f.width * 4))
    const at = (f.width - 1) * 4
    if (kind === 'last cell') f.axes[3][at] += 1
    else if (kind === 'endpoint') f.axes[3][at + 1] = 1
    else new Uint32Array(f.axes[3].buffer)[at + 1] += 1
    const p = planExactImageXTable(f)!
    expect([...p.uniform.slice(16)]).toEqual([0, 0, 0, 1])
    expect(p.xSampleCount).toBe(2)
  })
test('range certificate includes subnormals and signed HDR and excludes zero from exponent span', () => {
  const bits = new Uint32Array([1, 0x80000001, 0x7f7fffff, 0, 0, 0x80000000, 0xff7fffff, 0x80000000])
  const range = certifyExactImageRange(new Float32Array(bits.buffer))!
  expect(range.minimum).toEqual([1, 1, 254, 1]); expect(range.maximum).toEqual([1, 1, 254, 1])
  expect(Object.isFrozen(range)).toBe(true); expect(Object.isFrozen(range.minimum)).toBe(true)
  expect(certifyExactImageRange(new Float32Array([0, 1, 2, Infinity]))).toBeUndefined()
  expect(certifyExactImageRange(new Float32Array([0, NaN, 2, 1]))).toBeUndefined()
})
// Independent, deliberately simple per-channel reference. It visits channels
// separately and uses numeric sign/finite checks rather than the production
// unsigned-word sign gate and unrolled RGBA loop.
function referenceRange(pixels: Float32Array) {
  if (!pixels.length || pixels.length % 4 || !pixels.every(Number.isFinite)) return
  const words = new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.length)
  const minimum: number[] = [], maximum: number[] = []
  let opaqueAlpha = true, nonnegativeRgb = true
  for (let channel = 0; channel < 4; channel++) {
    const exponents: number[] = []
    for (let index = channel; index < pixels.length; index += 4) {
      if (channel === 3 && words[index] !== 0x3f800000) opaqueAlpha = false
      if (channel < 3 && pixels[index] < 0) nonnegativeRgb = false
      if (pixels[index] !== 0) exponents.push(Math.max(1, words[index] >>> 23 & 255))
    }
    minimum.push(exponents.length ? Math.min(...exponents) : 1)
    maximum.push(exponents.length ? Math.max(...exponents) : 1)
  }
  const unitAlpha=pixels.every((value,index)=>index%4!==3||value>=0&&value<=1)
  return { pixels: pixels.length / 4, minimum, maximum, opaqueAlpha, ...(unitAlpha?{unitAlpha:true}:{}), nonnegativeRgb }
}
test('complete range scan matches every exponent/sign boundary in every channel without modifying words', () => {
  for (let exponent = 0; exponent <= 255; exponent++) for (const mantissa of [0, 1, 0x3fffff, 0x7fffff])
    for (const sign of [0, 0x80000000]) for (let channel = 0; channel < 4; channel++) {
      const words = new Uint32Array([0, 0x80000000, 1, 0x3f800000, 0x3f000000, 0xbf000000, 0x00800000, 0x3f800000])
      words[4 + channel] = sign | exponent << 23 | mantissa
      const before = words.slice(), pixels = new Float32Array(words.buffer)
      expect(certifyExactImageRange(pixels)).toEqual(referenceRange(pixels))
      expect(words).toEqual(before)
    }
})
test('complete scan honors nonzero view offsets, all-zero channels, mixed signs and the final RGBA tuple', () => {
  let state = 0x439cb71d
  const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0 }
  for (let iteration = 0; iteration < 256; iteration++) {
    const count = 1 + iteration, words = new Uint32Array(count * 4 + 8).fill(0x7f800000)
    for (let index = 4; index < words.length - 4; index++) {
      const raw = next(), exponent = (raw >>> 23 & 255) % 255
      words[index] = raw & 0x807fffff | exponent << 23
      if (iteration % 7 === 0 && index % 4 === 1) words[index] = iteration % 2 ? 0x80000000 : 0
      if (iteration % 5 === 0 && index % 4 === 3) words[index] = 0x3f800000
    }
    const pixels = new Float32Array(words.buffer, 16, count * 4), before = words.slice()
    expect(certifyExactImageRange(pixels)).toEqual(referenceRange(pixels)); expect(words).toEqual(before)
    for (let channel = 0; channel < 4; channel++) for (const invalid of [0x7f800000, 0xff800000, 0x7f800001, 0xffc12345]) {
      const index = words.length - 8 + channel, original = words[index]
      words[index] = invalid
      expect(certifyExactImageRange(pixels)).toBeUndefined()
      words[index] = original
    }
  }
  for (const word of [0, 0x80000000]) {
    const pixels = new Float32Array(new Uint32Array(68).fill(word).buffer)
    expect(certifyExactImageRange(pixels)).toEqual({ pixels: 17, minimum: [1, 1, 1, 1], maximum: [1, 1, 1, 1],
      opaqueAlpha: false, unitAlpha:true, nonnegativeRgb: true })
  }
})
test('opaque alpha requires every raw alpha word to be exactly one, never just the exponent range', () => {
  const f = fixture()
  expect(f.range.opaqueAlpha).toBe(true)
  expect(planExactImageXTable(f)!.uniform[7]).toBe(1)
  expect(planExactImageXTable(f)!.uniform[6]).toBe(3)
  for (const raw of [0x3fc00000, 0x80000000, 0, 0x3f800001, 0xbf800000]) {
    const pixels = f.pixels.slice(), bits = new Uint32Array(pixels.buffer)
    bits[bits.length - 1] = raw
    const range = certifyExactImageRange(pixels)!
    expect(range.opaqueAlpha, raw.toString(16)).toBe(false)
    const plan = planExactImageXTable({ ...f, range })!
    expect(plan.uniform[7]).toBe(0); expect(plan.uniform[6]).toBe(4)
    expect(plan.tableBytes).toBe(4 * f.width * plan.rowCount * 4 * 12)
    if (raw === 0x3fc00000 || raw === 0x3f800001) {
      expect(range.minimum[3]).toBe(f.range.minimum[3])
      expect(range.maximum[3]).toBe(f.range.maximum[3])
    }
  }
  const rgbHdr = f.pixels.slice(); rgbHdr[0] = -4096; rgbHdr[1] = 16384
  expect(certifyExactImageRange(rgbHdr)!.opaqueAlpha).toBe(true)
})
test('nonnegative RGB proof rejects every negative nonzero word, permits signed zero, and leaves alpha independent', () => {
  for (const raw of [0, 0x80000000, 1, 0x7f7fffff, 0x80000001, 0xbf800000, 0xff7fffff]) {
    for (let channel = 0; channel < 3; channel++) {
      const words = new Uint32Array([0x3f800000, 0x3f800000, 0x3f800000, 0x3f800000]); words[channel] = raw
      const range = certifyExactImageRange(new Float32Array(words.buffer))!
      expect(range.nonnegativeRgb, `${channel}:${raw.toString(16)}`).toBe(!(raw & 0x80000000) || !(raw & 0x7fffffff))
      expect(range.opaqueAlpha).toBe(true); expect(Object.isFrozen(range)).toBe(true)
    }
  }
  for (const alpha of [-2, -0, 0, .5, 1, 2]) {
    const pixels = new Float32Array([1, 2, 3, alpha]), original = new Uint32Array(pixels.buffer).slice()
    const range = certifyExactImageRange(pixels)!
    expect(range.nonnegativeRgb).toBe(true); expect(range.opaqueAlpha).toBe(alpha === 1)
    expect(new Uint32Array(pixels.buffer)).toEqual(original)
  }
})
test('range certificates cannot be hand-assembled or reused for another image size', () => {
  const f = fixture()
  expect(planExactImageXTable({ ...f, range: { ...f.range } as ExactImageRange })).toBeUndefined()
  expect(planExactImageXTable({ ...f, imageWidth: 7 })).toBeUndefined()
  expect(certifyExactImageRange(new Float32Array(new SharedArrayBuffer(16)))).toBeUndefined()
  const concurrent = new Float32Array(new SharedArrayBuffer(f.axes[0].byteLength)); concurrent.set(f.axes[0])
  expect(planExactImageXTable({ ...f, axes: [concurrent, ...f.axes.slice(1)] })).toBeUndefined()
})
test('plans retain their exact upload range identity and reject forged or cross-range ownership', () => {
  const f = fixture(), planA = planExactImageXTable(f)!
  const rangeB = certifyExactImageRange(new Float32Array(f.pixels.length).fill(2))!
  const planB = planExactImageXTable({ ...f, range: rangeB })!
  expect(imageXTablePlanRange(planA)).toBe(f.range)
  expect(imageXTablePlanRange(planB)).toBe(rangeB)
  expect(imageXTablePlanRange(planB)).not.toBe(f.range)
  expect(planA.uniform.slice(4, 6)).toEqual(planB.uniform.slice(4, 6))
  expect(planA.uniform.slice(8, 12)).not.toEqual(planB.uniform.slice(8, 12))
  expect(imageXTablePlanRange({ ...planA })).toBeUndefined()
  expect(imageXTablePlanRange(structuredClone(planA))).toBeUndefined()
})
test('compact storage saves padding only and rejects changes to its admitted stride or byte count', () => {
  const f = fixture(), rgb = planExactImageXTable(f)!
  const paddedBytes = 4 * f.width * rgb.rowCount * 4 * 16
  expect(rgb.tableBytes / paddedBytes).toBe(9 / 16)
  const nonOpaque = f.pixels.slice(); nonOpaque[3] = .5
  const rgba = planExactImageXTable({ ...f, range: certifyExactImageRange(nonOpaque)! })!
  expect(rgba.tableBytes / paddedBytes).toBe(3 / 4)
  expect(4 * 3484 * 12 * 3 * 12).toBe(6_020_352)
  rgb.uniform[6] = 4
  expect(imageXTablePlanRange(rgb)).toBeUndefined()
  rgba.tableBytes += 4
  expect(imageXTablePlanRange(rgba)).toBeUndefined()
})
const invalidAxes: [string, number, number][] = [
  ['negative cell', 0, -1], ['missing neighbour', 0, 7], ['fractional cell', 0, 1.25],
  ['negative weight', 1, -.1], ['weight above one', 1, 1.01], ['nonfinite weight', 1, Infinity],
  ['nan weight', 1, NaN], ['contain gap', 2, 0], ['dense marker', 3, 0],
  ['nonfinite cell', 16, NaN], ['Y missing neighbour', 16, 7], ['Y invalid marker', 19, 0],
]
test.each(invalidAxes)('unsupported metadata keeps the original sampler: %s', (_name, at, value) => {
  const f = fixture(); f.axes[2][at] = value
  expect(planExactImageXTable(f)).toBeUndefined()
})
test('table budget and both signed accumulator bounds are enforced before allocation', () => {
  const f = fixture(), accepted = planExactImageXTable(f)!
  expect(planExactImageXTable({ ...f, maxTableBytes: accepted.tableBytes - 1 })).toBeUndefined()
  expect(planExactImageXTable({ ...f, maxTableBytes: accepted.tableBytes })).toBeDefined()
  const bits = new Uint32Array(f.pixels.buffer); bits[0] = 1; bits[4] = 0x7f7fffff
  expect(planExactImageXTable({ ...f, range: certifyExactImageRange(f.pixels)! })).toBeUndefined()
  const g = fixture(); for (const a of g.axes) a[1] = 2 ** -72
  expect(planExactImageXTable(g)).toBeUndefined() // H would require 96 magnitude bits.
  const h = fixture(); for (const a of h.axes) { a[1] = 2 ** -60; a[17] = 2 ** -41 }
  expect(planExactImageXTable(h)).toBeUndefined() // 24 + 60 + 41 + 2 exceeds 126.
})

// CPU limb model of the new WGSL, checked against an independent BigInt
// rational oracle. This validates arithmetic/bounds, never actual GPU code.
type Words = [number, number, number, number]
const MASK = (1n << 128n) - 1n
function words(n: bigint): Words {
  n &= MASK; return [0, 1, 2, 3].map(i => Number(n >> BigInt(i * 32) & 0xffffffffn)) as Words
}
function signed(w: Words): bigint {
  const n = w.reduce((v, part, i) => v + (BigInt(part) << BigInt(i * 32)), 0n)
  return w[3] & 0x80000000 ? n - (1n << 128n) : n
}
function add(a: Words, b: Words): Words {
  const s = a.map((v, i) => (v + b[i]) >>> 0), r = [...s] as Words
  let c = Number(s[0] < a[0])
  for (let i = 1; i < 4; i++) { r[i] = (s[i] + c) >>> 0; c = Number(s[i] < a[i] || r[i] < s[i]) }
  return r
}
const neg = (a: Words) => add(a.map(v => ~v >>> 0) as Words, [1, 0, 0, 0])
const sub = (a: Words, b: Words) => add(a, neg(b))
function shift(a: Words, amount: number): Words {
  if (amount >= 128) return [0, 0, 0, 0]
  const offset = amount & 31, whole = amount >>> 5, v = a.map((_, i) => i < whole ? 0 : a[i - whole])
  return v.map((part, i) => offset ? ((part << offset) | (i ? v[i - 1] >>> (32 - offset) : 0)) >>> 0 : part) as Words
}
function mulWord(a: number, b: number) {
  const a0 = a & 65535, a1 = a >>> 16, b0 = b & 65535, b1 = b >>> 16
  const p0 = a0 * b0, p1 = a1 * b0, p2 = a0 * b1
  const carry = (p0 >>> 16) + (p1 & 65535) + (p2 & 65535)
  return [((p0 & 65535) | carry << 16) >>> 0, (a1 * b1 + (p1 >>> 16) + (p2 >>> 16) + (carry >>> 16)) >>> 0]
}
function times(a: Words, b: number): Words {
  const p0 = mulWord(a[0], b), p1 = mulWord(a[1], b), p2 = mulWord(a[2], b)
  const r1 = (p1[0] + p0[1]) >>> 0, s2 = (p2[0] + p1[1]) >>> 0, r2 = (s2 + Number(r1 < p1[0])) >>> 0
  return [p0[0], r1, r2, (Math.imul(a[3], b) + p2[1] + Number(s2 < p2[0] || r2 < s2)) >>> 0]
}
function decode(raw: number, minimum: number): Words {
  if (!(raw & 0x7fffffff)) return [0, 0, 0, 0]
  const exponent = raw >>> 23 & 255, m = (raw & 0x7fffff) | (exponent ? 0x800000 : 0)
  const a = shift([m, 0, 0, 0], Math.max(exponent, 1) - minimum)
  return raw >>> 31 ? neg(a) : a
}
function rounded(w: Words, quantum: number): number {
  const negative = !!(w[3] & 0x80000000), a = negative ? neg(w) : w
  if (a.every(v => !v)) return 0
  let last = 0; for (let i = 1; i < 4; i++) if (a[i]) last = i
  const top = last * 32 + 31 - Math.clz32(a[last]), exponent = top + quantum
  const amount = Math.max(exponent - 23, -149) - quantum
  let m = 0
  if (amount <= 0) m = a[0] << -amount >>> 0
  else if (amount < 128) {
    const index = amount >>> 5, offset = amount & 31
    m = a[index] >>> offset
    if (offset && index < 3) m = (m | a[index + 1] << (32 - offset)) >>> 0
    const guard = amount - 1, word = guard >>> 5, bit = guard & 31
    const high = !!(a[word] & (1 << bit)), sticky = !!(a[word] & (2 ** bit - 1)) || a.slice(0, word).some(v => !!v)
    if (high && (sticky || m & 1)) m++
  }
  let rawExponent = exponent >= -126 ? exponent + 127 : 0
  if (m >= 0x1000000) { m >>>= 1; rawExponent++ }
  if (!rawExponent && m >= 0x800000) rawExponent = 1
  return ((negative ? 0x80000000 : 0) | (rawExponent >= 255 ? 0x7f800000 : rawExponent << 23 | m & 0x7fffff)) >>> 0
}
function dyadic(raw: number): [bigint, number] {
  const e = raw >>> 23 & 255
  return [BigInt((raw & 0x7fffff) | (e ? 0x800000 : 0)) * (raw >>> 31 ? -1n : 1n), Math.max(1, e) - 150]
}
function compareDyadic(a: bigint, ae: number, b: bigint, be: number) {
  const e = Math.min(ae, be), x = a << BigInt(ae - e), y = b << BigInt(be - e)
  return x < y ? -1 : x > y ? 1 : 0
}
/** Independent nearest-float search; no limb extraction or candidate RNE logic. */
function oracleRound(value: bigint, quantum: number): number {
  if (!value) return 0
  const sign = value < 0 ? 0x80000000 : 0, n = value < 0 ? -value : value
  let low = 0, high = 0x7f7fffff
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2), [m, e] = dyadic(mid)
    if (compareDyadic(m, e, n, quantum) <= 0) low = mid; else high = mid - 1
  }
  if (low === 0x7f7fffff) return (sign | low) >>> 0
  const [a, ae] = dyadic(low), [b, be] = dyadic(low + 1), common = Math.min(ae, be)
  const midpoint = (a << BigInt(ae - common)) + (b << BigInt(be - common))
  const comparison = compareDyadic(n, quantum + 1, midpoint, common)
  const result = comparison > 0 || comparison === 0 && (low & 1) ? low + 1 : low
  return (sign | result) >>> 0
}
function check(p: number[], u: number, ku: number, v: number, kv: number) {
  const exponents = p.filter(raw => raw & 0x7fffffff).map(raw => Math.max(raw >>> 23 & 255, 1))
  const minimum = exponents.length ? Math.min(...exponents) : 1, maximum = exponents.length ? Math.max(...exponents) : 1
  const bound = 24 + maximum - minimum
  if (bound + ku > 95 || bound + ku + kv + 2 > 126) return false
  const a = p.map(raw => decode(raw, minimum))
  const h0 = add(shift(a[0], ku), times(sub(a[1], a[0]), u)), h1 = add(shift(a[2], ku), times(sub(a[3], a[2]), u))
  // The actual table drops limb4 and sign-extends limb3 when sampling.
  const stored = (h: Words): Words => [h[0], h[1], h[2], h[2] & 0x80000000 ? 0xffffffff : 0]
  expect(signed(stored(h0))).toBe(signed(h0)); expect(signed(stored(h1))).toBe(signed(h1))
  const result = add(shift(stored(h0), kv), times(sub(stored(h1), stored(h0)), v))
  const aligned = p.map(raw => { const [m, e] = dyadic(raw); return m << BigInt(e - (minimum - 150)) })
  const ux = BigInt(u), vy = BigInt(v), dx = 1n << BigInt(ku), dy = 1n << BigInt(kv)
  const expected = aligned[0] * (dx - ux) * (dy - vy) + aligned[1] * ux * (dy - vy) +
    aligned[2] * (dx - ux) * vy + aligned[3] * ux * vy
  expect(signed(result)).toBe(expected)
  const quantum = minimum - 150 - ku - kv
  expect(rounded(result, quantum)).toBe(oracleRound(expected, quantum))
  return true
}
test('H96 plus one Y multiplication matches independent exact rational/RNE oracle at boundaries', () => {
  const colors = [
    [0, 0x80000000, 0, 0x80000000], [1, 2, 0x80000001, 0x80000002],
    [0x3f800000, 0x3f800000, 0x3f800000, 0x3f800000],
    [0x007fffff, 0x00800000, 0x00800001, 0], [0x3f800000, 0x3f800001, 0x3f800002, 0x3f800003],
    [0x7f7fffff, 0xff7fffff, 0x7f7ffffe, 0xff7ffffe], [0x3f800000, 0xbf800000, 0xbf800000, 0x3f800000],
    [0x80000001, 0, 0x80000001, 0],
  ]
  for (const p of colors) for (const [u, ku, v, kv] of [[0, 0, 0, 0], [1, 0, 1, 0], [1, 1, 0, 0],
    [1, 1, 1, 1], [1, 36, 1, 35], [0xffffff, 24, 0xfffffd, 24], [1, 48, 1, 48]])
    expect(check(p, u, ku, v, kv)).toBe(true)
})
test('signed96 storage reaches its admitted boundary and exact RNE preserves negative underflow zero', () => {
  const high = (72 << 23 | 0x7fffff) >>> 0
  expect(check([high, high | 0x80000000, 1, 0x80000001], 1, 0, 0xffffff, 29)).toBe(true)
  expect(rounded(words(-1n), -150)).toBe(0x80000000) // Exactly -half of the smallest subnormal.
  expect(rounded(words(-1n), -151)).toBe(0x80000000)
  expect(rounded(words(-1n), -300)).toBe(0x80000000) // shift >= 128.
  expect(rounded(words(1n), -300)).toBe(0)
  expect(rounded(words(-3n), -150)).toBe(0x80000002) // Tie chooses the even subnormal.
  for (const quantum of [-300, -278, -151, -150, -149])
    for (const n of [-3n, -1n, 1n, 3n]) expect(rounded(words(n), quantum)).toBe(oracleRound(n, quantum))
})
test('random signed finite HDR neighborhoods match the exact oracle including cancellation', () => {
  let state = 0x742a59b1
  const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0 }
  let checked = 0
  for (let i = 0; i < 1000; i++) {
    const base = 1 + next() % 224, span = next() % 24
    const p = Array.from({ length: 4 }, () => ((next() & 0x807fffff) | ((base + next() % (span + 1)) << 23)) >>> 0)
    const ku = 1 + next() % 49, kv = 1 + next() % 49
    const u = next() % 2 ** Math.min(ku, 24), v = next() % 2 ** Math.min(kv, 24)
    if (check(p, u, ku, v, kv)) checked++
  }
  expect(checked).toBeGreaterThan(850)
})

test.each([false, true].flatMap(opaque => [false, true].map(repeatedX => ({ opaque, repeatedX }))))(
  'production compact H stores/loads preserve all samples, opaque=$opaque, repeatedX=$repeatedX', ({ opaque, repeatedX }) => {
  const f = fixture(), pixelBits = new Uint32Array(f.pixels.buffer)
  if (repeatedX) {
    f.axes[2].set(f.axes[0].subarray(0, f.width * 4))
    f.axes[3].set(f.axes[1].subarray(0, f.width * 4))
  }
  for (let pixel = 0; pixel < f.pixels.length / 4; pixel++) for (let c = 0; c < 4; c++)
    pixelBits[pixel * 4 + c] = c === 3 ? opaque ? 0x3f800000 : [0, 0x3f000000, 0x3fc00000, 0xbe800000][pixel % 4]
      : (((112 + (pixel + c) % 9) << 23) | ((pixel * 32771 + c * 65539) & 0x7fffff) | (pixel % 3 === c ? 0x80000000 : 0)) >>> 0
  const plan = planExactImageXTable({ ...f, range: certifyExactImageRange(f.pixels)! })!, channels = plan.uniform[6]
  expect(channels).toBe(opaque ? 3 : 4)
  const compact = new Uint32Array(plan.tableBytes / 4), visits = new Uint8Array(compact.length)
  const checked = new Proxy(compact, { set(target, property, value) {
    const at = Number(property)
    if (!Number.isSafeInteger(at) || at < 0 || at >= target.length) throw Error(`H table out-of-range store: ${String(property)}`)
    if (++visits[at] !== 1) throw Error(`H table overlapping store at ${at}`)
    target[at] = value; return true
  } })
  const writeStart = exactImageXTableBuildWgsl.indexOf('  let at=(index*channels+c)*3u;')
  const writeEnd = exactImageXTableBuildWgsl.indexOf('\n }', writeStart)
  expect(writeStart).toBeGreaterThan(0); expect(writeEnd).toBeGreaterThan(writeStart)
  const writeBody = exactImageXTableBuildWgsl.slice(writeStart, writeEnd)
    .replace(/\b(\d+)u\b/g, '$1').replace(/h\.([xyz])/g, (_m, axis) => `h[${'xyz'.indexOf(axis)}]`)
  const store = new Function('xiTable', 'index', 'channels', 'c', 'h', writeBody) as
    (table: Uint32Array, index: number, channels: number, channel: number, h: Words) => void
  const readStart = exactImageXTableSampleWgsl.indexOf('fn xiTableSigned96(')
  const readOpen = exactImageXTableSampleWgsl.indexOf('{', readStart), readEnd = exactImageXTableSampleWgsl.indexOf('}', readOpen)
  expect(readStart).toBeGreaterThan(0)
  const readBody = exactImageXTableSampleWgsl.slice(readOpen + 1, readEnd).replace(/\b(\d+)u\b/g, '$1').replace('vec4<u32>', 'vec4u')
  const read = new Function('xiTable', 'xiSigned96', 'vec4u', `return function(at){${readBody}}`)(compact,
    (w: Words): Words => [w[0], w[1], w[2], w[2] & 0x80000000 ? 0xffffffff : 0], (...w: number[]) => w) as (at: number) => Words
  const padded = new Uint32Array(plan.xSampleCount * f.width * plan.rowCount * 4 * 4)
  for (let sample = 0; sample < plan.xSampleCount; sample++) for (let row = 0; row < plan.rowCount; row++)
    for (let x = 0; x < f.width; x++) for (let c = 0; c < channels; c++) {
      const xm = (sample * f.width + x) * 4, qx = plan.x[xm], source = ((plan.rowMin + row) * f.imageWidth + qx) * 4 + c
      const a = decode(pixelBits[source], plan.uniform[8 + c]), b = decode(pixelBits[source + 4], plan.uniform[8 + c])
      const h = add(shift(a, plan.x[xm + 2]), times(sub(b, a), plan.x[xm + 1]))
      const index = (sample * plan.rowCount + row) * f.width + x
      store(checked, index, channels, c, h)
      padded.set([h[0], h[1], h[2], 0], (index * 4 + c) * 4)
      const recovered = read((index * channels + c) * 3)
      expect(signed(recovered)).toBe(signed(h))
      expect(recovered.slice(0, 3)).toEqual([...padded.slice((index * 4 + c) * 4, (index * 4 + c) * 4 + 3)])
    }
  expect(visits.every(count => count === 1)).toBe(true)
  const atStart = exactImageXTableSampleWgsl.indexOf('let at=((group*rows+y.x)*width+pixel.x)*channels*3u;')
  expect(atStart).toBeGreaterThan(0)
  const atBody = exactImageXTableSampleWgsl.slice(atStart, exactImageXTableSampleWgsl.indexOf(';', atStart) + 1).replace(/\b(\d+)u\b/g, '$1')
  const sampleAddress = new Function('group', 'rows', 'y', 'width', 'pixel', 'channels', `${atBody};return at;`) as
    (sample: number, rows: number, y: { x: number }, width: number, pixel: { x: number }, channels: number) => number
  for (let sample = 0; sample < 4; sample++) for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) {
    const group = plan.uniform[16 + sample], xm = (group * f.width + x) * 4, ym = (sample * f.height + y) * 4
    const at = sampleAddress(group, plan.rowCount, { x: plan.y[ym] }, f.width, { x }, channels)
    const stride = f.width * channels * 3
    expect(at + stride + channels * 3).toBeLessThanOrEqual(compact.length)
    for (let c = 0; c < 4; c++) {
      const minimum = plan.uniform[8 + c], ku = plan.x[xm + 2], kv = plan.y[ym + 2]
      const u = BigInt(plan.x[xm + 1]), v = BigInt(plan.y[ym + 1]), dx = 1n << BigInt(ku), dy = 1n << BigInt(kv)
      const original = f.axes[sample], span = Math.max(f.width, f.height)
      const originalBits = new Uint32Array(original.buffer)
      // The oracle reads the original sample's X/Y inputs, independently of
      // the shared program index used by the production table addressing.
      const qx = original[x * 4], qy = original[(span + y) * 4]
      expect(Number(u) / Number(dx)).toBe(original[x * 4 + 1])
      expect(Number(v) / Number(dy)).toBe(original[(span + y) * 4 + 1])
      expect(originalBits[x * 4 + 2]).toBe(0x3f800000)
      const source = (qy * f.imageWidth + qx) * 4 + c
      const inputs = [source, source + 4, source + f.imageWidth * 4, source + f.imageWidth * 4 + 4].map(i => {
        const [m, e] = dyadic(pixelBits[i]); return m << BigInt(e - (minimum - 150))
      })
      const numerator = inputs[0] * (dx - u) * (dy - v) + inputs[1] * u * (dy - v) + inputs[2] * (dx - u) * v + inputs[3] * u * v
      let actual = 0x3f800000
      if (c < channels) {
        const a = read(at + c * 3), b = read(at + stride + c * 3)
        actual = rounded(add(shift(a, kv), times(sub(b, a), Number(v))), minimum - 150 - ku - kv)
      }
      expect(actual).toBe(oracleRound(numerator, minimum - 150 - ku - kv))
    }
  }
})
