import { expect, test } from 'vitest'
import { SampleOnlyAreaPrograms } from './sample-only-area-programs'
import { ResidentPrograms } from './resident-programs'
import { sampleOnlyAreaShaderWgsl } from './sample-only-area-shader'
import original from '../../../../../design-studio/crates/design-kernel/shaders/area.wgsl?raw'
import type { PathMesh } from './types'

function program(kind: 3 | 4 = 3, width = 8, height = 2, first = 5) {
  const count = kind === 4 ? 7 : 1 + height * 4 + height * 4 * 3
  const curves = new Float32Array((first + count) * 4), start = first * 4
  curves.set([kind, kind === 4 ? 0 : 1, width, height], start)
  if (kind === 4) { curves.set([0, width, 0, 0, 0, height, 0, 0], start + 4) }
  else for (let row = 0; row < height * 4; row++) {
    const at = 1 + height * 4 + row * 3
    curves.set([at, 1, 0, 0], start + 4 + row * 4); curves.set([0, width, 0, 0], start + at * 4)
  }
  const path: PathMesh = { area: { first, count, fingerprint: [13, 29] }, rect: { x: -13, y: 29, w: width, h: height },
    first: 0, count: 3, rule: 'nonzero', sampleCount: 4 }
  const arena = new ResidentPrograms(), plan = arena.plan(curves, [path.area!])!, proof = new SampleOnlyAreaPrograms(), buffer = {}
  proof.bind(plan.words, plan.offsets, [path.area!], buffer, 1)
  const accepts = (phase: number | undefined = 0) => proof.accepts(path, phase, path.rect, plan.offsets.get(first), buffer, 1)
  return { curves, path, arena, plan, proof, buffer, accepts, start }
}
function functionBody(source: string, name: string) {
  const first = source.indexOf(`fn ${name}(`); let at = source.indexOf('{', first), depth = 1
  while (depth && ++at < source.length) { if (source[at] === '{') depth++; else if (source[at] === '}') depth-- }
  return source.slice(first, at + 1)
}

test('sample-only shader keeps classification functions byte-identical and excludes analytic ALU/private arrays', () => {
  for (const name of ['cvBits', 'sampleBits', 'compare64', 'sampleInside', 'sampleOffset', 'firstSpan', 'sampleCoverage'])
    expect(functionBody(sampleOnlyAreaShaderWgsl, name)).toBe(functionBody(original, name))
  for (const name of ['cvWords', 'cvWidth', 'cvProduct', 'cvAxis', 'areaCoverage', 'addRN', 'mulRN']) expect(sampleOnlyAreaShaderWgsl).not.toContain(name)
  expect(sampleOnlyAreaShaderWgsl).toContain('sampleCoverage(pixel,u32(params.values[9].z)-1u)')
})

test.each([3, 4] as const)('real resident header %i accepts only the four original sample phases including negative-origin regions', kind => {
  const f = program(kind)
  expect(f.plan.offsets.get(f.path.area!.first)).toBe(0)
  for (let phase = 0; phase < 4; phase++) expect(f.accepts(phase)).toBe(true)
  for (const phase of [-1, .5, 4, NaN]) expect(f.accepts(phase)).toBe(false)
  expect(f.proof.accepts(f.path, undefined, f.path.rect, 0, f.buffer, 1)).toBe(false)
  expect(f.proof.accepts(f.path, 0, { x: -15, y: 28, w: 3, h: 4 }, 0, f.buffer, 1)).toBe(true)
})

test('foreign buffer/epoch/first/length/dimensions/sample count cannot borrow a previous binding', () => {
  const f = program()
  expect(f.proof.accepts(f.path, 0, f.path.rect, 0, {}, 1)).toBe(false)
  expect(f.proof.accepts(f.path, 0, f.path.rect, 0, f.buffer, 2)).toBe(false)
  expect(f.proof.accepts(f.path, 0, f.path.rect, 5, f.buffer, 1)).toBe(false)
  for (const path of [{ ...f.path, area: { ...f.path.area!, first: 0 } }, { ...f.path, area: { ...f.path.area!, count: f.path.area!.count - 1 } },
    { ...f.path, rect: { ...f.path.rect, w: 7 } }, { ...f.path, sampleCount: 16 as const }, { ...f.path, count: 0 }])
    expect(f.proof.accepts(path, 0, path.rect, 0, f.buffer, 1)).toBe(false)
  f.proof.resetFrame(); expect(f.accepts()).toBe(false)
  f.proof.bind(f.plan.words, new Map(), [f.path.area!], f.buffer, 2); expect(f.proof.accepts(f.path, 0, f.path.rect, 0, f.buffer, 2)).toBe(false)
})

test('private arena bytes survive caller-array mutation; changed uploaded headers and ABA arenas revoke binding', () => {
  const f = program(); f.curves[f.start] = 2
  expect(f.accepts()).toBe(true) // the GPU upload owns the private copy, not caller memory
  const changed = f.arena.plan(f.curves, [f.path.area!])!
  f.proof.bind(changed.words, changed.offsets, [f.path.area!], f.buffer, 2)
  expect(f.proof.accepts(f.path, 0, f.path.rect, changed.offsets.get(5), f.buffer, 2)).toBe(false)
  const empty = new Uint32Array(f.plan.words.length)
  f.proof.bind(empty, new Map([[5, 0]]), [f.path.area!], f.buffer, 3)
  expect(f.proof.accepts(f.path, 0, f.path.rect, 0, f.buffer, 3)).toBe(false)
})

test('same ArrayBuffer with a foreign byte offset cannot reuse a cached header', () => {
  const f = program(4), all = new Uint32Array(f.plan.words.length * 2)
  all.set(f.plan.words)
  f.proof.bind(all.subarray(0, f.plan.words.length), new Map([[5, 0]]), [f.path.area!], f.buffer, 1)
  expect(f.accepts()).toBe(true)
  f.proof.bind(all.subarray(f.plan.words.length), new Map([[5, 0]]), [f.path.area!], f.buffer, 1)
  expect(f.accepts()).toBe(false)
})

test.each(['analytic', 'empty', 'unknown', 'bad-size', 'bad-row-origin', 'bad-row-count', 'overrun', 'reserved', 'bad-limb', 'nonfinite-endpoint', 'reverse-range'] as const)(
  'foreign/malformed %s header retains original area path', variant => {
    const f = program(), c = f.curves, begin = f.start, payload = begin + (1 + f.path.rect.h * 4) * 4
    if (variant === 'analytic') c[begin] = 0
    if (variant === 'empty') c[begin] = 2
    if (variant === 'unknown') c[begin] = 5
    if (variant === 'bad-size') c[begin + 2] = NaN
    if (variant === 'bad-row-origin') c[begin + 4] = 0
    if (variant === 'bad-row-count') c[begin + 5] = .5
    if (variant === 'overrun') c[begin + 4] = f.path.area!.count
    if (variant === 'reserved') c[begin + 6] = 2
    if (variant === 'bad-limb') c[payload + 4] = 65536
    if (variant === 'nonfinite-endpoint') c[payload + 7] = 32752
    if (variant === 'reverse-range') c[payload] = c[payload + 1] + 1
    const arena = new ResidentPrograms(), plan = arena.plan(c, [f.path.area!])!
    f.proof.bind(plan.words, plan.offsets, [f.path.area!], f.buffer, 2)
    expect(f.proof.accepts(f.path, 0, f.path.rect, plan.offsets.get(5), f.buffer, 2)).toBe(false)
  })

test('a single-span full-row marker is accepted by the private program proof', () => {
  const f = program(); f.curves[f.start + 6] = 1
  const plan = new ResidentPrograms().plan(f.curves, [f.path.area!])!
  f.proof.bind(plan.words, plan.offsets, [f.path.area!], f.buffer, 1)
  expect(f.accepts()).toBe(true)
})

test('header4 requires the complete seven vectors and original finite endpoint format', () => {
  const f = program(4); f.curves[f.start + 1] = 1
  const plan = new ResidentPrograms().plan(f.curves, [f.path.area!])!
  f.proof.bind(plan.words, plan.offsets, [f.path.area!], f.buffer, 1); expect(f.accepts()).toBe(false)
})

test('repeated row payloads cannot evade the bounded format-work budget', () => {
  const height = 8192, table = 1 + height * 4, count = table + 9 * 3, curves = new Float32Array(count * 4)
  curves.set([3, 1, 8, height]); for (let row = 0; row < height * 4; row++) curves.set([table, 9, 0, 0], 4 + row * 4)
  for (let i = 0; i < 9; i++) curves.set([i, i, 0, 0], (table + i * 3) * 4)
  const area = { first: 0, count, fingerprint: [1, 2] as [number, number] }, path: PathMesh = {
    area, sampleCount: 4, rect: { x: 0, y: 0, w: 8, h: height }, first: 0, count: 3, rule: 'nonzero' }
  const proof = new SampleOnlyAreaPrograms(), buffer = {}
  proof.bind(new Uint32Array(curves.buffer), new Map([[0, 0]]), [area], buffer, 1)
  expect(proof.accepts(path, 0, path.rect, 0, buffer, 1)).toBe(false)
})

test('compact exact row spans require sorted in-range pixel intervals',()=>{
  const path:PathMesh={area:{first:0,count:3,fingerprint:[5,1]},sampleCount:4,rect:{x:0,y:0,w:8,h:1},first:0,count:3,rule:'nonzero'}
  const check=(last:number)=>{
    const words=new Float32Array([5,1,8,1, 0,-1,-13,8, 2,2,last,0])
    const buffer={},proof=new SampleOnlyAreaPrograms(),arena=new ResidentPrograms()
    const plan=arena.plan(words,[path.area!])!
    proof.bind(plan.words,plan.offsets,[path.area!],buffer,1)
    return proof.accepts(path,3,path.rect,plan.offsets.get(0),buffer,1)
  }
  expect(check(3*9+7)).toBe(true)
  expect(check(1*9+7)).toBe(false)
  expect(check(3*9+2)).toBe(false)
})
