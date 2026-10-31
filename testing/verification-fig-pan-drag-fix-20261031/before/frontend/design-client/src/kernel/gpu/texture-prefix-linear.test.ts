import { afterEach, expect, test, vi } from 'vitest'
import { rational_tent_kernel_rgba } from '../../generated/design-kernel/design_kernel'
import { prefixModule } from './prefix-module'
import shader from './texture-prefix.wgsl?raw'

afterEach(() => vi.unstubAllEnvs())
const mask = (1n << 128n) - 1n, limit = 1n << 127n
const wrap = (v: bigint) => v & mask
const signed = (v: bigint) => v >= limit ? v - (1n << 128n) : v
const abs = (v: bigint) => v < 0n ? -v : v
const high = (v: bigint) => v ? v.toString(2).length - 1 : -1
type Result = { numerator: bigint; accepted: number }
function productionFunction(name: string) {
  const start = shader.indexOf(`fn ${name}(`), open = shader.indexOf('{', start)
  if (start < 0 || open < 0) throw Error(`Missing production ${name}`)
  let end = open + 1, depth = 1
  while (depth && end < shader.length) { if (shader[end] === '{') depth++; if (shader[end] === '}') depth--; end++ }
  if (depth) throw Error(`Unclosed production ${name}`)
  const signature = shader.slice(start, open)
  const parameters = signature.slice(signature.indexOf('(') + 1, signature.indexOf(')')).split(',').map(a => a.split(':')[0].trim()).join(',')
  const body = shader.slice(open + 1, end - 1)
    .replace(/\bvar\b/g, 'let').replace(/\b(0x[0-9a-f]+|\d+)u\b/gi, '$1')
    .replace(/\b(\w+)\.([xyzw])\b/g, (_m, value, axis) => `getWord(${value},${'xyzw'.indexOf(axis)})`)
    .replace(/intercept\[([^\]]+)\]/g, 'getWord(intercept,$1)').replace('word=shift/32;', 'word=Math.floor(shift/32);')
    .replace(/>>/g, '>>>')
  return `function ${name}(${parameters}){${body}}`
}
const bindings = {
  PrefixInt: (...parts: number[]) => parts.reduce((v, p, i) => v | BigInt(p >>> 0) << BigInt(i * 32), 0n),
  PrefixLinearFactor: (numerator: bigint, accepted: number): Result => ({ numerator, accepted }),
  prefix_add: (a: bigint, b: bigint) => wrap(a + b), prefix_sub: (a: bigint, b: bigint) => wrap(a - b),
  prefix_shl: (a: bigint, shift: number) => shift >= 128 ? 0n : wrap(a << BigInt(shift)),
  prefix_mul_u32: (a: bigint, b: number) => wrap(a * BigInt(b >>> 0)),
  prefix_compare: (a: bigint, b: bigint) => a < b ? -1 : a > b ? 1 : 0,
  getWord: (v: bigint, index: number) => Number(v >> BigInt(index * 32) & 0xffffffffn),
  countTrailingZeros: (v: number) => 31 - Math.clz32((v & -v) >>> 0), min: Math.min, any: (v: boolean) => v,
}
const candidate = new Function(...Object.keys(bindings), `${productionFunction('prefix_low')}\n${productionFunction('prefix_try_linear_factor')}\nreturn prefix_try_linear_factor;`)(...Object.values(bindings)) as
  (pixel: bigint, sums: bigint, distances: bigint, center: bigint, slope: bigint, intercept: bigint) => Result
function coefficients(radius: number) {
  const bytes = rational_tent_kernel_rgba(radius), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const cw = view.getUint32(0, true), reach = view.getUint32(8, true)
  const value = (index: number) => {
    let n = 0n
    for (let i = cw - 1; i >= 0; i--) n = n << 32n | BigInt(view.getUint32((4 + cw * index + i) * 4, true))
    return n
  }
  const center = value(1), slope = value(2) - value(3), intercept = value(2) + slope
  return { center, slope, intercept, reach, denominator: value(0) }
}
test('factored coefficient evaluation defaults on and supports an explicit fallback', () => {
  for (const flag of ['0']) {
    vi.stubEnv('VITE_DESIGN_PREFIX_FACTOR', flag)
    expect(prefixModule(true)).toContain('const PREFIX_FACTOR:bool=false;')
  }
  vi.stubEnv('VITE_DESIGN_PREFIX_FACTOR', undefined)
  expect(prefixModule(true)).toContain('const PREFIX_FACTOR:bool=true;')
  expect(shader).toContain('if(PREFIX_FACTOR){factored=prefix_try_linear_factor(pixel,sums,distances,center,slope,intercept);}')
  expect(shader).toContain('if(factored.accepted==0u){numerator=prefix_add(prefix_mul(pixel,center),prefix_sub(prefix_mul(sums,intercept),prefix_mul(distances,slope)));}')
  expect(shader).toContain('numerator=prefix_add(numerator,prefix_mul(samples,prefixCoefficient(d)));')
})
test('actual 117 native coefficients admit a single u32 multiply plus exact shifts', () => {
  for (const [radius, shift, dShift] of [[38.25948715209961, 37, 55], [1224.3035888671875, 27, 40]]) {
    const k = coefficients(radius)
    expect(k.intercept).toBe(30088485n << BigInt(shift))
    expect(k.intercept - k.center).toBe(1n << BigInt(dShift))
    expect(k.slope).toBe(3n << BigInt(dShift))
    expect(candidate(1n, 2n, 3n, k.center, k.slope, k.intercept)).toEqual({
      numerator: wrap(k.center + 2n * k.intercept - 3n * k.slope), accepted: 1,
    })
  }
})
test('invalid identities or a multiplier wider than u32 retain the original formula', () => {
  for (const [center, slope, intercept] of [
    [100n, 0n, 100n], [100n, 9n, 103n], [100n, 13n, 104n], [64n, 384n, 192n],
    [1n << 48n, 3n, (1n << 48n) + 1n], [1n << 126n, 3n << 126n, 1n << 127n],
  ]) expect(candidate(1n, 2n, 3n, center, slope, intercept).accepted).toBe(0)
  const precise = coefficients(38 + 2 ** -26)
  expect(high(precise.denominator)).toBeLessThanOrEqual(95)
  expect(candidate(1n, 2n, 3n, precise.center, precise.slope, precise.intercept).accepted).toBe(0)
})
test.each([3.125, 32.25, 38.25948715209961, 48.5, 511.75, 513, 1024, 1224.3035888671875, 2048])(
  'production factor helper preserves signed128 numerators and bounds at native radius %s', radius => {
    const k = coefficients(radius), d = k.intercept - k.center
    for (const length of [1, 79, 1108, 3484, 16384]) {
      const l = Math.min(length, 2 * k.reach + 1), b = Math.floor(Math.log2(l)) + 1
      const weighted = Math.max(high(k.center) + b + 3, high(k.slope) + 2 * b + 4)
      const span = Math.min(40, 123 - 24 - weighted - 3)
      if (span < 0 || high(k.denominator) > 95) continue
      const m = (1n << BigInt(24 + span)) - 1n, count = BigInt(l)
      let state = 0x52c18a37
      const random = (bound: bigint) => {
        state ^= state << 13; state ^= state >>> 17; state ^= state << 5
        const n = bound * BigInt(state >>> 0) / 0xffffffffn
        return state & 1 ? n : -n
      }
      const cases = [[0n, 0n, 0n], [m, (count - 1n) * m, count * count * m],
        [-m, -(count - 1n) * m, -count * count * m], [m, -(count - 1n) * m, count * count * m],
        ...Array.from({ length: 64 }, () => [random(m), random((count - 1n) * m), random(count * count * m)])]
      for (const [pixel, sums, distances] of cases) {
        const actual = candidate(wrap(pixel), wrap(sums), wrap(distances), k.center, k.slope, k.intercept)
        expect(actual.accepted).toBe(1)
        const old = pixel * k.center + sums * k.intercept - distances * k.slope
        expect(signed(actual.numerator)).toBe(old)
        // Bound new meaningful intermediates before common-power factoring.
        // Dividing their common power of two only reduces their magnitude.
        for (const value of [pixel + sums, pixel + 3n * distances,
          (pixel + sums) * k.intercept, (pixel + 3n * distances) * d,
          (pixel + sums) * k.intercept - (pixel + 3n * distances) * d])
          expect(abs(value)).toBeLessThan(limit)
      }
    }
  },
)
