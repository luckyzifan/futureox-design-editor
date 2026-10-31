import { afterEach, expect, test, vi } from 'vitest'
import { paint } from '../../model'
import { GpuRenderer, type Surface } from './renderer'
import type { Driver, GpuNode, Rect, Texture } from './types'

afterEach(() => vi.unstubAllEnvs())
function fixture() {
  vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX', '1')
  const words = new Map<Texture, Uint32Array>(), calls: { mode: number; output: Rect; inputs: Texture[]; u: Float32Array }[] = []
  const create = (w: number, h: number) => {
    const texture = { width: w, height: h, bytes: w * h * 16, resource: {} } as Texture
    words.set(texture, new Uint32Array(w * h * 4)); return texture
  }
  const driver = { name: 'webgpu', managed: true, exactSolidPaintOver: true, zeroTextureSampling: true, constantTextureSampling: true,
    create, clear: vi.fn((texture: Texture) => words.get(texture)!.fill(0)), destroy: vi.fn(),
    pass: vi.fn((target: Texture, u: Float32Array, inputs: Texture[]) => {
      calls.push({ mode: u[16], output: { x: u[0], y: u[1], w: u[2], h: u[3] }, inputs, u: u.slice() })
    }),
    copyColorRegion: vi.fn((target: Texture, source: Texture, r: Rect, to: [number, number]) => {
      for (let y = 0; y < r.h; y++) words.get(target)!.set(words.get(source)!.subarray(((r.y + y) * source.width + r.x) * 4,
        ((r.y + y) * source.width + r.x + r.w) * 4), ((to[1] + y) * target.width + to[0]) * 4)
    }) }
  const renderer = new GpuRenderer(driver as unknown as Driver, true, false) as any
  const bounds = { x: 0, y: 0, w: 64, h: 48 }
  renderer.scene = { extent: bounds, rootInputBox: [0, 0, 64, 48], coherentSamples: true, curves: [], nodes: {} }
  renderer.reclaimScratch = vi.fn(async () => {})
  renderer.configurePaint = () => {}
  const node = (id: string, r: Rect, color = '#123456') => ({ id, rect: r, children: [], effects: [], strokes: [],
    fills: [paint(color)], blend: 'normal', opacity: 1, postCompositeBox: [0, 0, 64, 48],
    fill: { count: 0, rect: r } }) as unknown as GpuNode
  const mask = (r: Rect) => {
    const texture = create(r.w, r.h); texture.binaryCoverage = true
    return { texture, rect: r } as Surface
  }
  return { renderer, driver, bounds, node, mask, words, calls }
}
function invariantProgram(f: ReturnType<typeof fixture>, n: GpuNode, remainder = 0) {
  const h = n.fill.rect.h, header = 1 + h * 4, curves = new Float32Array((header + h * 4 * 3) * 4)
  const bits = new DataView(new ArrayBuffer(8)); bits.setFloat64(0, remainder, true)
  const words = Array.from({ length: 4 }, (_, i) => bits.getUint16(i * 2, true))
  curves.set([3, 1, n.fill.rect.w, h])
  for (let row = 0; row < h * 4; row++) {
    curves.set([header + row * 3, 1, 0, 0], 4 + row * 4)
    curves.set([0, n.fill.rect.w, 0, 0, ...words, ...words], (header + row * 3) * 4)
  }
  n.fill.count = 3; n.fill.sampleCount = 4; n.fill.area = { first: 0, count: curves.length / 4 }
  f.renderer.scene.curves = curves
  const cache = new Map<string, Surface>()
  f.renderer.nodeMask = (node: GpuNode) => {
    const key = `${node.id}:${f.renderer.sampleIndex}`
    if (!cache.has(key)) cache.set(key, f.mask(node.fill.rect))
    return cache.get(key)
  }
  return cache
}

test('disjoint later solid siblings grow physical support while retaining the complete parent writable bounds', async () => {
  const f = fixture(), a = f.node('a', { x: 3, y: 5, w: 7, h: 6 }), b = f.node('b', { x: 41, y: 31, w: 9, h: 8 })
  const empty = f.renderer.empty(f.bounds), ma = f.mask(a.rect), mb = f.mask(b.rect)
  const first = f.renderer.paintOver(a, a.fills[0], ma, empty, undefined, true, true) as Surface
  expect(first.rect).toEqual(a.rect); expect(first.logicalBounds).toEqual(f.bounds)
  expect(first.texture.uniformColor).toBeUndefined()
  const second = f.renderer.paintOver(b, b.fills[0], mb, first, undefined, true, true) as Surface
  expect(second.rect).toEqual({ x: 3, y: 5, w: 47, h: 34 }); expect(second.logicalBounds).toEqual(f.bounds)
  expect(f.calls.filter(call => call.mode === 47).map(call => call.output)).toEqual([a.rect, second.rect])
  expect(f.calls.at(-1)!.u.slice(4, 8)).toEqual(new Float32Array([3, 5, 7, 6]))
  const raw = f.words.get(second.texture)!
  raw.set([0x80000000, 0x7f7fffff, 0x00000001, 0x3f800001])
  const [expanded] = await f.renderer.materializePainterTargets([second]) as Surface[]
  expect(expanded.rect).toEqual(f.bounds); expect(expanded.logicalBounds).toBeUndefined()
  expect(f.driver.copyColorRegion).toHaveBeenCalledExactlyOnceWith(expanded.texture, second.texture,
    { x: 0, y: 0, w: 47, h: 34 }, [3, 5])
  const expected = new Uint32Array(64 * 48 * 4)
  for (let y = 0; y < 34; y++) expected.set(raw.subarray(y * 47 * 4, (y + 1) * 47 * 4), ((5 + y) * 64 + 3) * 4)
  expect(f.words.get(expanded.texture)).toEqual(expected)
})

test('clip bounds constrain only new support; existing physical pixels and logical target remain intact', () => {
  const f = fixture(), a = f.node('a', { x: 3, y: 5, w: 7, h: 6 }), b = f.node('b', { x: 30, y: 20, w: 12, h: 12 })
  const first = f.renderer.paintOver(a, a.fills[0], f.mask(a.rect), f.renderer.empty(f.bounds), undefined, true, true) as Surface
  const clip = f.mask({ x: 34, y: 22, w: 3, h: 4 })
  const next = f.renderer.paintOver(b, b.fills[0], f.mask(b.rect), first, clip, true, true) as Surface
  expect(next.rect).toEqual({ x: 3, y: 5, w: 34, h: 21 }); expect(next.logicalBounds).toEqual(f.bounds)
  expect(f.calls.at(-1)!.u[19]).toBe(1); expect(f.calls.at(-1)!.inputs[2]).toBe(clip.texture)
  const outside = f.node('outside', { x: 100, y: 100, w: 2, h: 2 })
  expect(f.renderer.paintOver(outside, outside.fills[0], f.mask(outside.rect), next, undefined, true, true)).toBe(next)
})

test('a changed native suffix copies the intersecting physical window directly into its zero-padded small domain', async () => {
  const f = fixture(), n = f.node('a', { x: 3, y: 5, w: 7, h: 6 })
  const source = f.renderer.paintOver(n, n.fills[0], f.mask(n.rect), f.renderer.empty(f.bounds), undefined, true, true) as Surface
  const raw = f.words.get(source.texture)!
  for (let i = 0; i < raw.length; i++) raw[i] = i % 2 ? 0x7f7fffff : 0x80000000
  const [small] = await f.renderer.cropPainterTargets([source], [5, 4, 8, 4]) as Surface[]
  expect(small.rect).toEqual({ x: 5, y: 4, w: 8, h: 4 }); expect(small.logicalBounds).toBeUndefined()
  expect(f.driver.copyColorRegion).toHaveBeenCalledExactlyOnceWith(small.texture, source.texture,
    { x: 2, y: 0, w: 5, h: 3 }, [0, 1])
  const expected = new Uint32Array(8 * 4 * 4)
  for (let y = 0; y < 3; y++) expected.set(raw.subarray((y * 7 + 2) * 4, (y * 7 + 7) * 4), ((1 + y) * 8) * 4)
  expect(f.words.get(small.texture)).toEqual(expected)
  // A second suffix entirely outside physical support is known +0, while
  // remaining inside the authoritative writable parent bounds.
  const other = f.renderer.paintOver(n, n.fills[0], f.mask(n.rect), f.renderer.empty(f.bounds), undefined, true, true) as Surface
  const [empty] = await f.renderer.cropPainterTargets([other], [50, 40, 4, 4]) as Surface[]
  expect(f.words.get(empty.texture)).toEqual(new Uint32Array(4 * 4 * 4))
  expect(f.driver.copyColorRegion).toHaveBeenCalledOnce()
})

test('an unsupported child sees full physical inputs, and bundle return keeps copy and four-plane resolve contracts', async () => {
  const f = fixture(), a = f.node('a', { x: 3, y: 5, w: 7, h: 6 }), b = f.node('b', { x: 41, y: 31, w: 9, h: 8 }), group = f.node('group', f.bounds)
  group.children = ['nested']
  f.renderer.scene.nodes = { a, b, group }
  f.renderer.nodeMask = (n: GpuNode) => f.mask(n.rect)
  f.renderer.streamIsolatedFilter = vi.fn(async (n: GpuNode, targets: Surface[]) => {
    if (n.id !== 'group') return
    expect(targets.every(target => target.logicalBounds === undefined && target.rect.w === 64 && target.rect.h === 48)).toBe(true)
    return targets // Boundary witness; the complex renderer is not mocked as a pixel oracle.
  })
  const targets = f.renderer.emptyBundle(f.bounds)
  const result = await f.renderer.drawBundle(['a', 'b', 'group'], targets) as Surface[]
  expect(f.calls.filter(call => call.mode === 47).map(call => call.output.w)).toEqual([7, 7, 7, 7, 47, 47, 47, 47])
  expect(f.driver.copyColorRegion).toHaveBeenCalledTimes(4)
  expect(result.every(target => !target.logicalBounds && target.rect.w === 64 && target.rect.h === 48)).toBe(true)
  const copied = f.renderer.copy(result[0]) as Surface
  expect(copied.rect).toEqual(f.bounds)
  f.renderer.run(23, f.bounds, result)
  expect(f.calls.at(-1)!.u.slice(4, 8)).toEqual(new Float32Array([0, 0, 64, 48]))
})

test.each(['off', 'no-stage', 'unproved-zero', 'unproved-mask', 'hdr-overflow'] as const)('%s keeps the established full-domain solid path', mode => {
  const f = fixture(), n = f.node('a', { x: 3, y: 5, w: 7, h: 6 }), target = f.renderer.empty(f.bounds)
  const mask = f.mask(n.rect)
  if (mode === 'off') vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX', '0')
  if (mode === 'no-stage') delete f.renderer.scene.rootInputBox
  if (mode === 'unproved-zero') delete target.texture.transparentZero
  if (mode === 'unproved-mask') delete mask.texture.binaryCoverage
  if (mode === 'hdr-overflow') { n.fills[0].color = 'hdr'; f.renderer.scene.colors = { hdr: [3e38, 1, 1, 2] } }
  const result = f.renderer.paintOver(n, n.fills[0], mask, target, undefined, true, true) as Surface
  expect(result.rect).toEqual(f.bounds); expect(result.logicalBounds).toBeUndefined()
})

test('cancelled materialization encodes no copy and leaves the compact owner intact', async () => {
  const f = fixture(), n = f.node('a', { x: 3, y: 5, w: 7, h: 6 })
  const source = f.renderer.paintOver(n, n.fills[0], f.mask(n.rect), f.renderer.empty(f.bounds), undefined, true, true) as Surface
  let current = true
  f.renderer.frameCurrent = () => current
  f.renderer.reclaimScratch = async () => { current = false }
  await expect(f.renderer.materializePainterTargets([source])).rejects.toThrow('PREVIEW_CANCELLED')
  expect(f.driver.copyColorRegion).not.toHaveBeenCalled(); expect(f.renderer.busy.has(source.texture)).toBe(true)
})

test('finite HDR source products that could overflow accumulated over materialize before the original full-domain blend', async () => {
  const f = fixture(), max = Math.fround(3.402823466e38), alpha = Math.fround(.593925), opacity = Math.fround(.854675)
  f.renderer.scene.colors = { maximum: [max, max, max, 1], next: [max, max, max, alpha] }
  const a = f.node('a', { x: 3, y: 5, w: 7, h: 6 }, 'maximum'), b = f.node('b', a.rect, 'next')
  b.fills[0].opacity = opacity
  const first = f.renderer.paintOver(a, a.fills[0], f.mask(a.rect), f.renderer.empty(f.bounds), undefined, true, true) as Surface
  expect(first.compactMaxAbs).toEqual([max, max, max, 1])
  const source = Math.fround(Math.fround(max * alpha) * opacity), sourceAlpha = Math.fround(alpha * opacity)
  expect(Number.isFinite(source)).toBe(true)
  expect(Math.fround(source + Math.fround(max * Math.fround(1 - sourceAlpha)))).toBe(Infinity)
  const next = await f.renderer.paintOver(b, b.fills[0], f.mask(b.rect), first, undefined, true, true) as Surface
  expect(f.driver.copyColorRegion).toHaveBeenCalledOnce()
  expect(next.rect).toEqual(f.bounds); expect(next.logicalBounds).toBeUndefined()
  expect(f.calls.filter(call => call.mode === 47).map(call => call.output)).toEqual([a.rect, f.bounds])
})

test('an unknown accumulated-range witness declines compact continuation without changing authored HDR', async () => {
  const f = fixture(), n = f.node('a', { x: 3, y: 5, w: 7, h: 6 })
  const first = f.renderer.paintOver(n, n.fills[0], f.mask(n.rect), f.renderer.empty(f.bounds), undefined, true, true) as Surface
  delete first.compactMaxAbs
  const next = await f.renderer.paintOver(n, n.fills[0], f.mask(n.rect), first, undefined, true, true) as Surface
  expect(next.rect).toEqual(f.bounds); expect(next.logicalBounds).toBeUndefined()
  expect(n.fills[0].color).toBe('#123456')
})

test('hidden fills cannot keep a compact destination in the generic child lane', () => {
  const f = fixture(), n = f.node('hidden', { x: 3, y: 5, w: 7, h: 6 })
  n.fills[0].visible = false
  expect(f.renderer.compactSolidNode(n)).toBe(false)
})

test('a certified identical four-phase solid source stays compact through an isolated opacity parent and merges only once', async () => {
  const f = fixture(), n = f.node('solid', { x: 3, y: 5, w: 7, h: 6 }), parent = f.node('parent', f.bounds)
  parent.fills = []; parent.children = ['solid']; parent.opacity = Math.fround(.08)
  parent.childrenInputBox = [0, 0, 64, 48]
  f.renderer.scene.nodes = { parent, solid: n }
  const masks = invariantProgram(f, n)
  const base = f.renderer.acquire(f.bounds), targets = [base, ...Array.from({ length: 3 }, () => f.renderer.retain(base))]
  const result = await f.renderer.drawBundle(['parent'], targets) as Surface[]
  expect([...masks.keys()]).toEqual(['solid:0'])
  expect(f.calls.filter(call => call.mode === 47).map(call => call.output)).toEqual([n.rect])
  expect(f.calls.filter(call => call.mode === 29)).toHaveLength(1)
  expect(f.driver.copyColorRegion).not.toHaveBeenCalled()
  expect(result.every(plane => plane.texture === result[0].texture && !plane.logicalBounds)).toBe(true)
  expect(f.renderer.aliases.get(result[0].texture)).toBe(4)
})

test.each(['distinct-clip', 'different-coverage'] as const)('%s prevents cross-phase solid-result sharing', async mode => {
  const f = fixture(), n = f.node('solid', { x: 3, y: 5, w: 7, h: 6 })
  f.renderer.scene.nodes = { solid: n }
  const masks = invariantProgram(f, n, mode === 'different-coverage' ? .5 : 0)
  const clip = mode === 'distinct-clip' ? Array.from({ length: 4 }, () => f.mask(f.bounds)) : undefined
  const result = await f.renderer.drawBundle(['solid'], f.renderer.emptyBundle(f.bounds), clip) as Surface[]
  expect(f.calls.filter(call => call.mode === 47)).toHaveLength(4)
  expect(new Set(result.map(plane => plane.texture)).size).toBe(4)
  expect(masks.size).toBe(mode === 'different-coverage' ? 4 : 1)
})

test('a native all-one mask keeps its opaque interior and the cached constant lane precedes compact allocation', () => {
  const f = fixture(), n = f.node('full-opaque', f.bounds)
  n.fill.opaqueRect = { ...f.bounds }; n.fill.sampleCount = 4
  Object.assign(f.driver, { createBinaryCoverage: (w: number, h: number) => {
    const mask = f.driver.create(w, h); mask.binaryCoverage = true; return mask
  } })
  f.renderer.sampleIndex = 0
  const mask = f.renderer.nodeMask(n) as Surface, targets = f.renderer.emptyBundle(f.bounds) as Surface[]
  expect(mask.opaqueInterior).toEqual(f.bounds)
  const compact = vi.spyOn(f.renderer, 'compactSolidPlan')
  f.renderer.bytes = f.renderer.frameBudget - 16
  const out: Surface[] = []
  for (const target of targets) {
    expect(f.renderer.reclaimForPaintOver(n, n.fills[0], mask, target, undefined, true)).toBeUndefined()
    out.push(f.renderer.paintOver(n, n.fills[0], mask, target, undefined, true, true) as Surface)
  }
  expect(compact).not.toHaveBeenCalled(); expect(f.renderer.reclaimScratch).not.toHaveBeenCalled()
  expect(f.calls.filter(call => call.mode === 47)).toHaveLength(0)
  expect(f.calls.filter(call => call.mode === 12)).toHaveLength(2) // one mask, one color
  expect(out.every(surface => surface.texture === out[0].texture && surface.texture.width === 1 &&
    surface.texture.height === 1 && surface.texture.uniformColor && !surface.logicalBounds)).toBe(true)
  expect(f.renderer.aliases.get(out[0].texture)).toBe(5)
  expect(f.renderer.bytes).toBe(f.renderer.frameBudget)
})

test('constant-color cache identity compares actual RGBA32F words, including HDR and signed zero', () => {
  const f = fixture(), n = f.node('full-opaque', f.bounds)
  n.fill.opaqueRect = f.bounds; n.fill.sampleCount = 4; f.renderer.sampleIndex = 0
  f.renderer.scene.colors = { first: [0, 2, -0, 1], second: [-0, 2, 0, 1] }
  const mask = f.renderer.nodeMask(n) as Surface
  const outputs = ['first', 'second'].map(color => {
    const p = { ...n.fills[0], color }
    return f.renderer.paintOver(n, p, mask, f.renderer.empty(f.bounds), undefined, true, true) as Surface
  })
  expect(outputs[0].texture).not.toBe(outputs[1].texture)
  const uniforms = f.calls.filter(call => call.mode === 12).slice(-2).map(call =>
    [...new Uint32Array(call.u.buffer, call.u.byteOffset + 48 * 4, 4)])
  expect(uniforms).toEqual([[0, 0x40000000, 0x80000000, 0x3f800000], [0x80000000, 0x40000000, 0, 0x3f800000]])
})

test('opaque coverage over only the old physical window cannot replace the full logical target', () => {
  const f = fixture(), n = f.node('partial', { x: 3, y: 5, w: 7, h: 6 }), mask = f.mask(n.rect)
  const first = f.renderer.paintOver(n, n.fills[0], mask, f.renderer.empty(f.bounds), undefined, true, true) as Surface
  mask.opaqueInterior = n.rect
  const out = f.renderer.paintOver(n, n.fills[0], mask, first, undefined, true, true) as Surface
  expect(out.logicalBounds).toEqual(f.bounds); expect(out.texture.uniformColor).toBeUndefined()
  expect(f.calls.filter(call => call.mode === 47)).toHaveLength(2)
})
