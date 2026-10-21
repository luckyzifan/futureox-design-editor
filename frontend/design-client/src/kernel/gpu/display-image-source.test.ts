import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { displayImageSource, DISPLAY_IMAGE_SOURCE_MATH } from './display-image-source'
import { imageCoordinateSource } from './image-coordinate-source'
import { scalarCoverageSource } from './scalar-coverage'
import { imageResolveStepWgsl } from './image-resolve-step'

const original = ['sampling', 'vector'].map(name => readFileSync(new URL(
  `../../../../../design-studio/crates/design-kernel/shaders/${name}.wgsl`, import.meta.url), 'utf8')).join('\n') + imageResolveStepWgsl
const addressed = scalarCoverageSource(imageCoordinateSource(original))
const generated = displayImageSource(addressed)
function definition(source: string, name: string) {
  const start = source.indexOf(`fn ${name}(`), open = source.indexOf('{', start)
  if (start < 0 || open < 0) throw Error(`Missing test function ${name}`)
  let end = open + 1, depth = 1
  while (depth && end < source.length) { if (source[end] === '{') depth++; if (source[end] === '}') depth--; end++ }
  if (depth) throw Error(`Unclosed test function ${name}`)
  return { whole: source.slice(start, end), body: source.slice(open + 1, end - 1) }
}

test('specialization changes only mode51 and appends private native helpers', () => {
  const names = [...addressed.matchAll(/\bfn (\w+)\(/g)].map(match => match[1])
  expect(new Set(names).size).toBe(names.length)
  for (const name of names) if (name !== 'exactImageResolveStep')
    expect(definition(generated, name).whole, name).toBe(definition(addressed, name).whole)
  const fragment = definition(generated, 'exactImageResolveStep').body
  expect(fragment).toBe(definition(addressed, 'exactImageResolveStep').body
    .replace(/\blinearImage\(/g, 'displayImageLinear(').replace(/\bimageResolveFinite\(/g, 'displayImageResolveFinite('))
  expect(fragment).toContain('previous=coverage_at_C(p,u(3))')
  expect(fragment).toContain('coverage_at_A(p,u(1)).a')
  expect(fragment).not.toContain('at(source')
  expect(DISPLAY_IMAGE_SOURCE_MATH).toBe('native-finite-image-v1')
})

test('all exact axes/dense/contain/origin and resolve-phase code is retained verbatim apart from private call targets', () => {
  expect(definition(generated, 'displayImageLinear').whole
    .replace('fn displayImageLinear(', 'fn linearImage(').replace('displayImageBilinear4(', 'bsBilinear4('))
    .toBe(definition(addressed, 'linearImage').whole)
  expect(definition(generated, 'displayImageResolveFinite').whole
    .replace('fn displayImageResolveFinite(', 'fn imageResolveFinite(')
    .replaceAll('displayImageMul4(', 'mulRN4(').replaceAll('displayImageAdd4(', 'addRN4('))
    .toBe(definition(addressed, 'imageResolveFinite').whole)
  const linear = definition(generated, 'displayImageLinear').body
  expect(linear).toContain('floor(p-u(51).xy)')
  expect(linear).toContain('if(x.z==0.||y.z==0.){return vec4<f32>(0);}')
  expect(linear).toContain('else{grid=textureLoad(sourceD,pixel,0);}')
  expect(linear.match(/linearImageTexel\(/g)).toHaveLength(4)
  for (const name of ['displayImageLinear', 'displayImageResolveFinite', 'displayImageBilinear4', 'displayImageLerp4'])
    expect(definition(generated, name).body).not.toMatch(/\b(?:\w*RN\w*|bs\w+)\(/)
})

test('unknown, duplicate, unspecialized coordinate and already-native sources fail closed', () => {
  expect(() => displayImageSource(original)).toThrow('Unsupported addressed')
  expect(() => displayImageSource(addressed.replace('fn linearImageTexel(', 'fn missingImageTexel('))).toThrow('Unexpected')
  expect(() => displayImageSource(addressed + definition(addressed, 'exactImageResolveStep').whole)).toThrow('Unexpected')
  const resolve = definition(addressed, 'imageResolveFinite').whole
  expect(() => displayImageSource(addressed.replace(resolve, resolve.replace('vec4<f32>(0.25)', 'vec4<f32>(0.125)')))).toThrow('Unsupported')
  expect(() => displayImageSource(generated)).toThrow('already specialized')
})

const f32 = Math.fround
const bits = (v: number) => new Uint32Array(new Float32Array([v]).buffer)[0]
const value = (v: number) => new Float32Array(new Uint32Array([v]).buffer)[0]
const add = (a: number[], b: number[]) => a.map((v, i) => f32(v + b[i]))
const mul = (a: number[], b: number[] | number) => a.map((v, i) => f32(v * (typeof b === 'number' ? b : b[i])))
const splat = (v: number) => [v, v, v, v]
// Execute production control flow. CPU primitives model separately rounded
// f32; real GPU compilation/contraction and visual acceptance remain untested.
const lerp = new Function('add', 'mul', 'f32', `return (a,b,t)=>{${definition(generated, 'displayImageLerp4').body
  .replace('a*(1.-t)+b*t', 'add(mul(a,f32(1-t)),mul(b,t))')}}`)(add, mul, f32) as (a: number[], b: number[], t: number) => number[]
const bilinear = new Function('displayImageLerp4', `return (a,b,c,d,k)=>{${definition(generated, 'displayImageBilinear4').body}}`)(lerp) as
  (a: number[], b: number[], c: number[], d: number[], k: { x: number; y: number }) => number[]
function resolveFunction(name: string) {
  const body = definition(generated, name).body.replace(/\bvar\b/g, 'let').replace(/\b(0x[0-9a-f]+|\d+)u\b/gi, '$1')
    .replace(/vec4<f32>/g, 'splat').replace(/bitcast<u32>/g, 'floatBits').replace(/src\.a/g, 'src[3]')
  return new Function('displayImageMul4', 'displayImageAdd4', 'mulRN4', 'addRN4', 'splat', 'floatBits',
    `return (image,coverage,previous,sample)=>{${body}}`)(mul, add, mul, add, splat, bits) as
    (image: number[], coverage: number, previous: number[], sample: number) => number[]
}
const nativeResolve = resolveFunction('displayImageResolveFinite'), originalResolve = resolveFunction('imageResolveFinite')

function dyadic(v: number): [bigint, number] {
  const raw = bits(v), e = raw >>> 23 & 255
  if (!(raw & 0x7fffffff)) return [0n, -149]
  return [BigInt((raw & 0x7fffff) | (e ? 0x800000 : 0)), Math.max(e, 1) - 150]
}
function fraction(v: number): [bigint, number] {
  let [n, e] = dyadic(v)
  if (!n) return [0n, 0]
  if (e >= 0) return [n << BigInt(e), 0]
  while (!(n & 1n) && e < 0) { n >>= 1n; e++ }
  return [n, -e]
}
function rounded(n: bigint, quantum: number): number {
  if (!n) return 0
  const top = n.toString(2).length - 1
  let exponent = top + quantum
  const shift = Math.max(exponent - 23, -149) - quantum
  let mantissa: bigint
  if (shift <= 0) mantissa = n << BigInt(-shift)
  else {
    mantissa = n >> BigInt(shift)
    const tail = n & ((1n << BigInt(shift)) - 1n), half = 1n << BigInt(shift - 1)
    if (tail > half || tail === half && (mantissa & 1n)) mantissa++
  }
  if (mantissa >= 0x1000000n) { mantissa >>= 1n; exponent++ }
  let rawExponent = exponent >= -126 ? exponent + 127 : 0
  if (rawExponent === 0 && mantissa >= 0x800000n) rawExponent = 1
  return value(rawExponent << 23 | Number(mantissa & 0x7fffffn))
}
function exactBilinear(corners: number[][], x: number, y: number) {
  const [u, ku] = fraction(x), [v, kv] = fraction(y), dx = 1n << BigInt(ku), dy = 1n << BigInt(kv)
  const weights = [(dx - u) * (dy - v), u * (dy - v), (dx - u) * v, u * v]
  return [0, 1, 2, 3].map(channel => {
    const decoded = corners.map(p => dyadic(p[channel])), quantum = Math.min(...decoded.map(([, e]) => e))
    const numerator = decoded.reduce((sum, [n, e], index) => sum + (n << BigInt(e - quantum)) * weights[index], 0n)
    return rounded(numerator, quantum - ku - kv)
  })
}

test('finite endpoints and canonical zero/alpha gates keep the original four-step boundaries', () => {
  const a = [-0, .25, .5, 1], b = [1.5, 1, 0, 1], c = [.125, .75, 1, 1], d = [1, 1.75, .25, 1]
  for (const [x, y, expected] of [[0, 0, a], [1, 0, b], [0, 1, c], [1, 1, d]] as const)
    expect(bilinear(a, b, c, d, { x, y }).map(bits)).toEqual(expected.map(bits))
  for (const coverage of [0, .125, .5, 1]) {
    let current = [0, 0, 0, 0], expected = [0, 0, 0, 0]
    for (let sample = 0; sample < 4; sample++) {
      current = nativeResolve([a, b, c, d][sample], coverage, current, sample)
      expected = originalResolve([a, b, c, d][sample], coverage, expected, sample)
      expect(current.map(bits)).toEqual(expected.map(bits))
    }
  }
  expect(nativeResolve([-0, -0, -0, 1], 1, [9, 9, 9, 9], 0).map(bits)).toEqual([0, 0, 0, bits(.25)])
  expect(nativeResolve([1.5, 1, .25, 0], 1, [9, 9, 9, 9], 0)).toEqual([0, 0, 0, 0])
})

test('bounded native image math stays close to independent exact dyadic bilinear and ordered four-sample resolve', () => {
  let state = 0x795bd241, maxSourceError = 0, maxResolvedError = 0
  const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0 }
  const fractions = [0, -0, 1, 2 ** -36, 2 ** -35, 1 - 2 ** -24, .125, .5, .875]
  for (let iteration = 0; iteration < 2000; iteration++) {
    let current = [0, 0, 0, 0], expected = [0, 0, 0, 0]
    for (let sample = 0; sample < 4; sample++) {
      const corners = Array.from({ length: 4 }, () => Array.from({ length: 4 }, (_, channel) => {
        if (channel === 3) return 1
        const word = next()
        return word % 17 === 0 ? 0 : value(((115 + word % 13) << 23) | (word & 0x7fffff))
      }))
      const x = iteration % 2 ? f32(next() / 0x100000000) : fractions[(iteration + sample) % fractions.length]
      const y = fractions[(iteration * 3 + sample + 2) % fractions.length]
      const approximate = bilinear(corners[0], corners[1], corners[2], corners[3], { x, y }), reference = exactBilinear(corners, x, y)
      for (let c = 0; c < 4; c++) maxSourceError = Math.max(maxSourceError, Math.abs(approximate[c] - reference[c]))
      current = nativeResolve(approximate, 1, current, sample)
      expected = originalResolve(reference, 1, expected, sample)
      for (let c = 0; c < 4; c++) maxResolvedError = Math.max(maxResolvedError, Math.abs(current[c] - expected[c]))
      expect(current[3]).toBe((sample + 1) / 4)
    }
  }
  expect(maxSourceError).toBeGreaterThan(0) // This is a visual tier, not a bit-exact claim.
  expect(maxSourceError).toBeLessThanOrEqual(2 ** -19)
  expect(maxResolvedError).toBeLessThanOrEqual(2 ** -19)
})
