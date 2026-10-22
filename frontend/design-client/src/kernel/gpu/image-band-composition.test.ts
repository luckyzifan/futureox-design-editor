import { afterEach, expect, test, vi } from 'vitest'
import { GpuRenderer, type Surface } from './renderer'
import { certifyExactImageRange } from './exact-image-x-table'
import { paint } from '../../model'
import type { Driver, GpuNode, Rect, Texture } from './types'

afterEach(() => vi.unstubAllEnvs())

function fixture(height = 130) {
  vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX', '1')
  const bounds = { x: -20, y: 12, w: 24, h: height }, words = new Map<Texture, Uint32Array>()
  const create = (w: number, h: number) => {
    const texture = { resource: {}, width: w, height: h, bytes: w * h * 16 } as Texture
    words.set(texture, new Uint32Array(w * h * 4)); return texture
  }
  const copy = vi.fn((to: Texture, from: Texture, region: Rect, offset: [number, number]) => {
    for (let y = 0; y < region.h; y++) words.get(to)!.set(words.get(from)!.subarray(
      ((region.y + y) * from.width + region.x) * 4, ((region.y + y) * from.width + region.x + region.w) * 4),
    ((offset[1] + y) * to.width + offset[0]) * 4)
  })
  const image = { texture: create(2, 2), rect: { x: 0, y: 0, w: 2, h: 2 } }, range = certifyExactImageRange(
    new Float32Array([.25, .5, 1, 1, .5, 1, .25, 1, 1, .25, .5, 1, .25, 1, .5, 1]))
  const driver = { name: 'webgpu', managed: true, constantTextureSampling: true, zeroTextureSampling: true,
    create, createBinaryCoverage: (w: number, h: number) => { const t = create(w, h); t.binaryCoverage = true; return t },
    pass: vi.fn(), clear: vi.fn(), destroy: vi.fn(), copyColorRegion: copy,
    imageTableRange: (texture: Texture) => texture === image.texture ? range : undefined }
  const renderer = new GpuRenderer(driver as unknown as Driver, true, false) as any
  const imagePaint = { ...paint('#ffffff'), kind: 'image', image: 'fixture' }
  const node = { id: 'image', rect: bounds, fill: { rect: bounds, opaqueRect: { ...bounds }, sampleCount: 4 },
    fills: [imagePaint], strokes: [], effects: [], children: [], opacity: 1, blend: 'normal', matrix: [1, 0, 0, 1, 0, 0],
    postCompositeBox: [-20, 12, 24, height] } as unknown as GpuNode
  const parent = { id: 'group', rect: bounds, fills: [], strokes: [], effects: [], children: ['absent', node.id], opacity: 1,
    blend: 'normal', childrenInputBox: [-20, 12, 24, height], postCompositeBox: [-20, 12, 24, height] } as unknown as GpuNode
  renderer.scene = { extent: bounds, coherentSamples: true, rootInputBox: [-20, 12, 24, height], nodes: { image: node, group: parent } }
  renderer.configurePaint = vi.fn((u: Float32Array) => { u[184] = renderer.sampleIndex; u[185] = 99 })
  renderer.imageFor = vi.fn(() => image)
  const field = { texture: create(130, 2), rect: { ...bounds } }
  renderer.imageGrid = vi.fn(() => field)
  renderer.reclaimScratch = vi.fn(async () => {})
  renderer.frameCurrent = () => true
  const first = renderer.acquire(bounds) as Surface
  words.get(first.texture)!.set(Array.from({ length: bounds.w * bounds.h * 4 }, (_, i) => [0x80000000, 0x7f800000, 0x7fc01234, 0x7f7fffff][i % 4]))
  const targets = [first, renderer.retain(first), renderer.retain(first), renderer.retain(first)] as Surface[]
  return { renderer, driver, image, range, node, parent, bounds, field, words, targets, first }
}

test('one isolated image child uses original mode2/mode3 phases and bounded positive-neighbour bands; final alias is updated in place', async () => {
  const f = fixture(), original = f.words.get(f.first.texture)!.slice()
  const out = await f.renderer.streamImageLeaf(f.parent, f.targets) as Surface[]
  expect(out).toBe(f.targets)
  expect(out.slice(0, 3).every(s => s.texture !== f.first.texture)).toBe(true)
  expect(out[3].texture).toBe(f.first.texture); expect(f.renderer.aliases.get(f.first.texture)).toBe(1)
  const paints = f.driver.pass.mock.calls.filter(call => call[1][16] === 2)
  const merges = f.driver.pass.mock.calls.filter(call => call[1][16] === 3)
  expect(paints).toHaveLength(12); expect(merges).toHaveLength(12)
  expect(paints.map(call => [...call[1].slice(0, 4)])).toEqual(Array.from({ length: 4 }, () =>
    [[-20, 12, 24, 65], [-20, 76, 24, 65], [-20, 140, 24, 2]]).flat())
  expect(paints.map(call => call[1][184])).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3])
  expect(paints.every(call => call[2][1] === f.image.texture && call[2][3] === f.field.texture && call[1][204] === -20 && call[1][205] === 12)).toBe(true)
  expect(merges.map(call => call[3])).toEqual(Array.from({ length: 4 }, () =>
    [{ x: 0, y: 0, w: 24, h: 64 }, { x: 0, y: 64, w: 24, h: 64 }, { x: 0, y: 128, w: 24, h: 2 }]).flat())
  expect(merges.every(call => [...call[1].slice(0, 4)].join() === '-20,12,24,130' && call[1][18] === 1)).toBe(true)
  expect(f.driver.copyColorRegion.mock.calls.map(call => call[2])).toEqual([
    { x: 0, y: 0, w: 24, h: 65 }, { x: 0, y: 64, w: 24, h: 65 }, { x: 0, y: 128, w: 24, h: 2 }])
  for (const [saved, source, region] of f.driver.copyColorRegion.mock.calls) {
    expect(source).toBe(f.first.texture)
    expect(f.words.get(saved)!.subarray(0, region.h * region.w * 4)).toEqual(original.subarray(region.y * 24 * 4, (region.y + region.h) * 24 * 4))
  }
  expect(f.renderer.sequentialImagePins.size).toBe(0)
  expect(f.renderer.sampleIndex).toBeUndefined()
})

test('four shared destination aliases finish below five full color planes without releasing a still-readable alias', async () => {
  const f = fixture(258), fullBytes = 24 * 258 * 16
  // Include the queue-ordered reusable 65-row pair and the two-row tail pair.
  f.renderer.frameBudget = fullBytes * 4 + 24 * (65 + 2) * 16 * 2 + 16
  let maxBusy = 0
  f.driver.pass.mockImplementation((_texture, u, inputs) => {
    maxBusy = Math.max(maxBusy, [...f.renderer.busy].filter((t: Texture) => t.width === 24 && t.height === 258).length)
    if (u[16] === 3) for (const texture of inputs) expect(f.renderer.busy.has(texture) || texture === f.image.texture).toBe(true)
  })
  const out = await f.renderer.streamImageLeaf(f.parent, f.targets) as Surface[]
  expect(out).toHaveLength(4); expect(new Set(out.map(s => s.texture)).size).toBe(4)
  expect(maxBusy).toBe(4); expect(f.renderer.peak).toBeLessThan(fullBytes * 5)
  expect(f.driver.destroy).not.toHaveBeenCalled()
})

test('fields are reacquired only after each admission and the pinned image remains protected across every checkpoint opportunity', async () => {
  const f = fixture(), sequence: string[] = []
  f.renderer.reclaimScratch = vi.fn(async () => {
    expect(f.renderer.sequentialImagePins.has(f.image.texture)).toBe(true)
    sequence.push('admit')
  })
  f.renderer.imageGrid = vi.fn(() => { sequence.push('field'); return f.field })
  await f.renderer.streamImageLeaf(f.parent, f.targets)
  expect(f.renderer.imageGrid).toHaveBeenCalledTimes(12)
  for (let i = 0; i < sequence.length; i++) if (sequence[i] === 'field') expect(sequence[i - 1]).toBe('admit')
  expect(f.renderer.sequentialImagePins.has(f.image.texture)).toBe(false)
})

test.each(['off', 'clip', 'mips', 'atlas', 'display-material', 'fractional', 'partial-mask', 'sample-count', 'parent-opacity', 'child-opacity',
  'child-effect', 'two-visible', 'mask-child', 'children-domain', 'child-suffix', 'different-target'] as const)('%s keeps the old full image path before any image upload or pass', async mode => {
  const f = fixture(); let clip: Surface[] | undefined
  if (mode === 'off') vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX', '0')
  if (mode === 'clip') clip = f.targets
  if (mode === 'mips') f.renderer.imageMips = true
  if (mode === 'atlas') f.renderer.imageAtlas = true
  if (mode === 'display-material') f.renderer.scene.displayMaterialSource = true
  if (mode === 'fractional') f.node.rect = { ...f.node.rect, x: -20.25 }
  if (mode === 'partial-mask') f.node.fill.opaqueRect!.w--
  if (mode === 'sample-count') f.node.fill.sampleCount = 16
  if (mode === 'parent-opacity') f.parent.opacity = .5
  if (mode === 'child-opacity') f.node.opacity = .5
  if (mode === 'child-effect') f.node.effects.push({ visible: true, kind: 'blur', radius: 1 } as any)
  if (mode === 'two-visible' || mode === 'mask-child') {
    f.renderer.scene.nodes.other = { ...f.node, id: 'other', mask: mode === 'mask-child', opacity: mode === 'mask-child' ? 0 : 1 }
    f.parent.children.push('other')
  }
  if (mode === 'children-domain') f.parent.childrenInputBox = [-20, 12, 24, 129]
  if (mode === 'child-suffix') f.node.postCompositeBox = [-20, 12, 24, 129]
  if (mode === 'different-target') f.targets[2].rect = { ...f.bounds, h: 129 }
  expect(await f.renderer.streamImageLeaf(f.parent, f.targets, clip)).toBeUndefined()
  expect(f.renderer.imageFor).not.toHaveBeenCalled(); expect(f.driver.pass).not.toHaveBeenCalled()
})

test('the independent finite-source host option still uses the original mode2 and mode3 for every image band', async () => {
  const f = fixture(); f.renderer.scene.displayImageSource = true
  expect(await f.renderer.streamImageLeaf(f.parent, f.targets)).toBe(f.targets)
  expect(f.driver.pass.mock.calls.filter(call => call[1][16] === 2)).toHaveLength(12)
  expect(f.driver.pass.mock.calls.filter(call => call[1][16] === 3)).toHaveLength(12)
  expect(f.driver.pass.mock.calls.some(call => call[1][16] === 51)).toBe(false)
})

test.each(['unknown', 'alpha', 'negative', 'hdr'] as const)('%s source range cannot replace the transparent isolation', async mode => {
  const f = fixture()
  f.driver.imageTableRange = () => mode === 'unknown' ? undefined : certifyExactImageRange(new Float32Array([
    mode === 'negative' ? -.25 : mode === 'hdr' ? 2 : .25, .5, 1, mode === 'alpha' ? .5 : 1]))
  expect(await f.renderer.streamImageLeaf(f.parent, f.targets)).toBeUndefined()
  expect(f.driver.pass.mock.calls.some(call => call[1][16] === 2 || call[1][16] === 3)).toBe(false)
  expect(f.renderer.aliases.get(f.first.texture)).toBe(4); expect(f.renderer.sequentialImagePins.size).toBe(0)
})

test('unproven alias counts and cache-owned surfaces never become feedback destinations', () => {
  const f = fixture()
  f.renderer.aliases.delete(f.first.texture)
  expect(f.renderer.privateBandDestination(f.first)).toBe(false)
  f.renderer.aliases.set(f.first.texture, 1)
  expect(f.renderer.privateBandDestination(f.first)).toBe(true)
  for (const cache of [f.renderer.constantTargets, f.renderer.images]) {
    cache.set('other-owner', f.first); expect(f.renderer.privateBandDestination(f.first)).toBe(false); cache.delete('other-owner')
  }
  f.first.texture.uniformColor = true; expect(f.renderer.privateBandDestination(f.first)).toBe(false)
})

test.each(['cancel', 'copy-failed', 'paint-failed'] as const)('%s releases band temporaries and pins without treating uncertain work as completed', async mode => {
  const f = fixture(); let current = true
  f.renderer.frameCurrent = () => current
  if (mode === 'cancel') f.renderer.reclaimScratch = vi.fn(async () => { current = false })
  if (mode === 'copy-failed') f.driver.copyColorRegion.mockImplementation(() => { throw Error('copy failed') })
  if (mode === 'paint-failed') f.driver.pass.mockImplementation((_texture, u) => { if (u[16] === 2) throw Error('paint failed') })
  await expect(f.renderer.streamImageLeaf(f.parent, f.targets)).rejects.toThrow(mode === 'cancel' ? 'PREVIEW_CANCELLED' : mode === 'copy-failed' ? 'copy failed' : 'paint failed')
  expect(f.renderer.sequentialImagePins.size).toBe(0); expect(f.renderer.sampleIndex).toBeUndefined()
  expect(f.driver.destroy).not.toHaveBeenCalled()
  // Frame abort owns successfully completed earlier sample outputs; no local
  // source/save allocation stays busy after an interrupted band.
  expect([...f.renderer.busy].filter((t: Texture) => t.width === 24 && t.height <= 65)).toHaveLength(0)
})
