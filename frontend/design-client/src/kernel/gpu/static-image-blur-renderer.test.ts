import { afterEach, expect, test, vi } from 'vitest'
import { GpuRenderer, type Surface } from './renderer'
import { certifyExactImageRange, imageXTablePlanRange } from './exact-image-x-table'
import { largeStaticImageBlurWindow } from './static-image-blur-cache'
import type { Driver, ExactImageTable, GpuNode, GpuScene, PathMesh, Rect, Texture } from './types'

afterEach(() => vi.unstubAllEnvs())
function coverage(r: Rect) {
  const header = 1 + r.h * 4, curves = new Float32Array((header + r.h * 12) * 4)
  curves.set([3, 1, r.w, r.h])
  for (let row = 0; row < r.h * 4; row++) {
    curves.set([header + row * 3, 1, 0, 0], 4 + row * 4)
    curves.set([0, r.w, 0, 0], (header + row * 3) * 4)
  }
  return { curves, path: { rect: r, count: 3, first: 0, rule: 'nonzero', sampleCount: 4,
    area: { first: 0, count: curves.length / 4 } } as PathMesh }
}
/** Real native coordinate fields and private plan admission; CPU transport
 * models exact storage, two filter neighborhoods and the unchanged merge
 * sequence. This is not a WGSL/Metal arithmetic equivalence claim. */
function fixture(enabled = true, signed = false) {
  vi.stubEnv('VITE_DESIGN_STATIC_IMAGE_BLUR_CACHE', enabled ? '1' : '0')
  vi.stubEnv('VITE_DESIGN_EXACT_IMAGE_X_TABLE', '1')
  vi.stubEnv('VITE_DESIGN_IMAGE_AXES', '1'); vi.stubEnv('VITE_DESIGN_STREAM_IMAGE_FIELDS', '1')
  vi.stubEnv('VITE_DESIGN_WHOLE_IMAGE_FILTER', '1'); vi.stubEnv('VITE_DESIGN_PREFIX_RGB_RESOLVE', '0')
  const output = { x: 100, y: 100, w: 12, h: 20 }, shape = { x: 0, y: 0, w: 256, h: 256 }
  const radius = 38.25948715209961, reach = 40, input = { x: 60, y: 60, w: 92, h: 100 }, c = coverage(shape)
  const sourcePixels = Float32Array.from({ length: 16 * 16 * 4 }, (_, i) => i % 4 === 3 ? 1 : signed ? -(i % 7) / 8 : (i % 7) / 8)
  const pixels = new Map<Texture, Float32Array>(), ranges = new WeakMap<Texture, NonNullable<ReturnType<typeof certifyExactImageRange>>>(), axes = new WeakMap<Texture, Float32Array>()
  const allocations: Texture[] = [], filters: number[] = [], merges: number[] = [], resolves: Rect[] = []
  const create = (w: number, h: number): Texture => {
    const texture = { width: w, height: h, bytes: w * h * 16, resource: {} } as Texture
    pixels.set(texture, new Float32Array(w * h * 4)); allocations.push(texture); return texture
  }
  const read = (texture: Texture, x: number, y: number, channel: number) =>
    x < 0 || y < 0 || x >= texture.width || y >= texture.height ? 0 : pixels.get(texture)![(y * texture.width + x) * 4 + channel]
  const driver = { name: 'webgpu', managed: true, description: 'CPU storage/command oracle', drawCalls: 0, triangles: 0,
    resourceEpoch: 0, completedResourceEpoch: 0, scratchBytes: 0, lost: false, create, createBinaryCoverage: create,
    sequentialSampleResolve: true, exactImageResolveStep: true, maskRegion() {},
    clear(texture: Texture) { pixels.get(texture)!.fill(0); ranges.delete(texture); axes.delete(texture) },
    destroy: vi.fn((texture: Texture) => { pixels.delete(texture); ranges.delete(texture); axes.delete(texture) }),
    uploadLinear: vi.fn((values: Float32Array, w: number, h: number) => {
      const texture = create(w, h); pixels.get(texture)!.set(values)
      const proof = certifyExactImageRange(values)!
      ranges.set(texture, proof); texture.finitePixels = true; return texture
    }),
    uploadParameters(values: Float32Array, w: number, h: number) {
      const texture = create(w, h); pixels.get(texture)!.set(values); axes.set(texture, values.slice()); texture.finitePixels = true; return texture
    },
    imageTableRange: (texture: Texture) => ranges.get(texture), imageTableAxes: (texture: Texture) => axes.get(texture)?.slice(),
    prepareImageTable: vi.fn(async (texture: Texture, plan: any, available: number) => {
      expect(imageXTablePlanRange(plan)).toBe(ranges.get(texture)); expect(plan.axes).toBeUndefined()
      const bytes = 256 + plan.tableBytes + plan.x.byteLength + plan.y.byteLength
      expect(bytes).toBeLessThanOrEqual(available); driver.scratchBytes += bytes
      return Object.freeze({ width: plan.width, height: plan.height, bytes, resource: Object.freeze({}), opaqueAlpha: true,
        ...(!signed ? { nonnegativeResolved: true } : {}) }) as ExactImageTable
    }),
    resolveImageTable(texture: Texture, _table: ExactImageTable, offsetX: number, offsetY: number) {
      resolves.push({ x: offsetX, y: offsetY, w: texture.width, h: texture.height })
      const data = pixels.get(texture)!
      for (let y = 0; y < texture.height; y++) for (let x = 0; x < texture.width; x++) for (let channel = 0; channel < 4; channel++) {
        const value = channel === 3 ? 1 : Math.fround(((input.x + offsetX + x) % 17) / 32 + ((input.y + offsetY + y) % 19) / 64 + channel / 128)
        data[(y * texture.width + x) * 4 + channel] = signed && channel === 0 ? -value : value
      }
    },
    retireImageTable: vi.fn(async (table: ExactImageTable) => { driver.scratchBytes -= table.bytes }),
    checkpoint: vi.fn(async () => { driver.completedResourceEpoch = driver.resourceEpoch - 1 }),
    pass(texture: Texture, u: Float32Array, sources: Texture[], region?: Rect) {
      const data = pixels.get(texture)!, mode = u[16]
      if (mode === 0) {
        const raw = new Uint32Array(data.buffer), source = new Uint32Array(pixels.get(sources[0])!.buffer)
        for (let y = 0; y < sources[0].height; y++) for (let x = 0; x < sources[0].width; x++) for (let channel = 0; channel < 4; channel++)
          raw[((y + region!.y) * texture.width + x + region!.x) * 4 + channel] = source[(y * sources[0].width + x) * 4 + channel]
        return
      }
      if (mode === 22) {
        const axis = u[37]; filters.push(axis)
        for (let y = 0; y < texture.height; y++) for (let x = 0; x < texture.width; x++) for (let channel = 0; channel < 4; channel++) {
          let sum = 0
          for (let delta = -reach + 1; delta < reach; delta++) {
            const xx = u[0] + x - u[4] + (axis === 0 ? delta : 0), yy = u[1] + y - u[5] + (axis === 1 ? delta : 0)
            sum = Math.fround(sum + Math.fround(read(sources[0], xx, yy, channel) * Math.fround((reach - Math.abs(delta)) / reach ** 2)))
          }
          data[(y * texture.width + x) * 4 + channel] = sum
        }
        return
      }
      expect([3, 29]).toContain(mode); merges.push(mode)
      for (let y = 0; y < texture.height; y++) for (let x = 0; x < texture.width; x++) for (let channel = 0; channel < 4; channel++) {
        const alpha = Math.fround(read(sources[0], u[0] + x - u[4], u[1] + y - u[5], 3) * u[18])
        data[(y * texture.width + x) * 4 + channel] = Math.fround(Math.fround(read(sources[0], u[0] + x - u[4], u[1] + y - u[5], channel) * u[18]) +
          Math.fround(read(sources[1], u[0] + x - u[8], u[1] + y - u[9], channel) * Math.fround(1 - alpha)))
      }
    },
  } as unknown as Driver & { resourceEpoch: number; completedResourceEpoch: number; scratchBytes: number }
  const load = vi.fn(() => ({ width: 16, height: 16, pixels: sourcePixels }))
  const renderer = new GpuRenderer(driver, true, false, load) as any
  // Keep this native-field/ownership transport small. Only the performance
  // size predicate is overridden; its real large/edge limits have a separate
  // test. Source, table, coverage, halo and equality admission remain real.
  const sizeGate = vi.spyOn(renderer, 'staticImageFilterWindowEligible').mockReturnValue(true)
  const node = { id: 'static-image', rect: shape, matrix: [1, 0, 0, 1, 0, 0], inverse: [1, 0, 0, 1, 0, 0], size: [256, 256],
    fill: c.path, fills: [{ id: 'image-paint', kind: 'image', color: '#ffffff', image: 'data:image/png;base64,eA==', fit: 'cover', visible: true, opacity: 1, blend: 'normal', stops: [] }],
    children: [], strokes: [], effects: [{ kind: 'blur', radius, visible: true }], opacity: .48, blend: 'normal' } as unknown as GpuNode
  const scene = { version: 7, width: output.w, height: output.h, extent: output, floatCompositing: true, coherentSamples: true, integratedBlur: true,
    background: '#ffffff', transparent: false, grid: false,
    view: { x: 0, y: 0, zoom: 1 }, roots: [node.id], nodes: { [node.id]: node }, curves: c.curves, vertices: [] } as GpuScene
  renderer.scene = scene
  const kernel = { texture: create(1, 1), rect: { x: 0, y: 0, w: 1, h: 1 } }
  renderer.filterKernel = () => kernel; renderer.certifiedKernel = () => undefined
  renderer.resolveFilterImageSample = vi.fn(() => { throw Error('Unexpected native-axis rejection in this admitted fixture') })
  const run = async (complete = true) => {
    driver.resourceEpoch++
    renderer.staticImageBlurs.begin('fixed-zoom-and-color', driver.completedResourceEpoch)
    const targets = Array.from({ length: 4 }, () => { const target = renderer.acquire(output); driver.clear(target.texture); return target })
    const result = await renderer.streamIsolatedFilter(node, targets) as Surface[]
    const raw = result.map(surface => new Uint32Array(pixels.get(surface.texture)!.buffer).slice())
    renderer.release(...result)
    if (complete) driver.completedResourceEpoch = driver.resourceEpoch
    renderer.staticImageBlurs.finish(true, driver.completedResourceEpoch)
    return raw
  }
  return { renderer, driver, node, scene, input, output, pixels, ranges, load, run, allocations, filters, merges, resolves, sizeGate }
}

for (const signed of [false, true]) test(`native-axis full hit skips upload/table/H/V and preserves four original merges (signed=${signed})`, async () => {
  const f = fixture(true, signed), before = await f.run()
  expect(f.renderer.staticImageBlurs.count).toBe(1)
  const counts = { uploads: f.load.mock.calls.length, filters: f.filters.length, resolves: f.resolves.length }
  const tableBuilds = (f.driver.prepareImageTable as any).mock.calls.length
  expect(await f.run()).toEqual(before)
  expect(f.renderer.staticImageBlurHits).toBe(1); expect(f.merges).toHaveLength(8)
  expect(f.load).toHaveBeenCalledTimes(counts.uploads); expect(f.filters).toHaveLength(counts.filters); expect(f.resolves).toHaveLength(counts.resolves)
  expect(f.driver.prepareImageTable).toHaveBeenCalledTimes(tableBuilds)
  const reference = fixture(false, signed); expect(await reference.run()).toEqual(before)
  expect(reference.renderer.staticImageBlurHits).toBe(0); expect(reference.renderer.staticImageBlurs.count).toBe(0)
})
test('source write revocation and native mapping changes force original computation', async () => {
  const f = fixture(); await f.run()
  const firstFilters = f.filters.length, texture = [...f.renderer.images.values()][0] as Surface
  f.ranges.delete(texture.texture); texture.texture.finitePixels = true
  const descriptor = f.renderer.staticImageSourceDescriptor(f.node.fills[0].image, 0, false)
  expect(f.renderer.staticImageBlurs.source(texture.texture, descriptor.uri, descriptor.policy)).toBeUndefined()
  expect(f.renderer.staticImageBlurs.count).toBe(0)
  const g = fixture(); await g.run(); const count = g.filters.length
  g.node.matrix[4] = -0
  await g.run(); expect(g.filters.length).toBeGreaterThan(count); expect(g.renderer.staticImageBlurHits).toBe(0)
  expect(firstFilters).toBeGreaterThan(0)
})
test('exact source remains pinned against forced eviction until cache retirement', async () => {
  const f = fixture(); await f.run()
  const image = [...f.renderer.images.values()][0] as Surface
  expect(f.renderer.staticImageBlurs.pinsSource(image.texture)).toBe(true)
  expect(f.renderer.hasEvictableImage()).toBe(false)
  f.renderer.evictImages(image.texture.bytes, true)
  expect(f.driver.destroy).not.toHaveBeenCalledWith(image.texture)
  f.renderer.staticImageBlurs.clear(); f.renderer.evictImages(image.texture.bytes, true)
  expect(f.driver.destroy).toHaveBeenCalledWith(image.texture)
})
test('incomplete native coverage, halo, changed window, unknown axes and high-radius work decline', async () => {
  const f = fixture(); await f.run()
  expect(f.renderer.staticImageFilterIdentity(f.node, f.input, f.output, 1224)).toBeUndefined()
  expect(f.renderer.staticImageFilterIdentity(f.node, { ...f.input, x: 61, w: 91 }, f.output, 38.25948715209961)).toBeUndefined()
  f.scene.compactImageFields = false
  expect(f.renderer.staticImageFilterIdentity(f.node, f.input, f.output, 38.25948715209961)).toBeUndefined()
  f.scene.compactImageFields = true; (f.scene.curves as Float32Array)[4 + f.input.y * 16 + 1] = 0
  expect(f.renderer.staticImageFilterIdentity(f.node, f.input, f.output, 38.25948715209961)).toBeUndefined()
})
test('cache ownership cannot become an explicit filter write destination', async () => {
  const f = fixture(); await f.run()
  const entry = (f.renderer.staticImageBlurs as any).entries[0]
  expect(() => f.renderer.run(22, entry.plane.rect, [], undefined, 15, { kind: 'tent', radius: 38 }, false, entry.plane)).toThrow('Invalid private exact filter destination')
  expect(f.renderer.memoryPolicy().workingBudgetBytes).toBe(256 * 1024 * 1024)
  expect(f.renderer.memoryPolicy().staticImageBlurBytes).toBe(f.output.w * f.output.h * 16)
})
test('edge tiles do not look up, replace or clear the common slot; a large-window miss retires before table work', async () => {
  const f = fixture(); await f.run()
  const cache = f.renderer.staticImageBlurs, first = (cache as any).entries[0].plane.texture
  f.sizeGate.mockImplementation((...args: unknown[]) => largeStaticImageBlurWindow(args[0] as Rect))
  await f.run()
  expect(cache.has(first)).toBe(true); expect(cache.count).toBe(1); expect(f.renderer.staticImageBlurHits).toBe(0)
  f.sizeGate.mockReturnValue(true)
  const prepare = f.renderer.prepareFilterImageTable.bind(f.renderer), beforeTable: number[] = []
  f.renderer.prepareFilterImageTable = (...args: unknown[]) => { beforeTable.push(cache.bytes); return prepare(...args) }
  f.scene.view.x = 1
  await f.run()
  expect(beforeTable).toEqual([0]); expect(cache.count).toBe(1); expect(f.renderer.staticImageBlurHits).toBe(0)
})
test('source descriptor does not encode the large URI into its small exact policy', () => {
  const f = fixture(), uri = 'data:image/png;base64,' + 'A'.repeat(100_000)
  const descriptor = f.renderer.staticImageSourceDescriptor(uri, 0, false)
  expect(descriptor.uri).toBe(uri); expect(descriptor.policy.length).toBeLessThan(1000)
  const other = f.renderer.staticImageSourceDescriptor(uri + 'B', 0, false)
  expect(other.policy).toBe(descriptor.policy); expect(other.uri).not.toBe(descriptor.uri)
})

function lifecycleFixture() {
  vi.stubEnv('VITE_DESIGN_STATIC_IMAGE_BLUR_CACHE', '1')
  let fail = false, inject = true, current = true, held: Surface | undefined
  const create = (w: number, h: number) => ({ width: w, height: h, bytes: w * h * 16, resource: {} }) as Texture
  const image = create(2, 2), range = Object.freeze({})
  const driver = { name: 'webgpu', managed: true, description: 'lifecycle transport only', lost: false,
    scratchBytes: 0, drawCalls: 0, triangles: 0, resourceEpoch: 0, completedResourceEpoch: 0,
    begin() { driver.resourceEpoch++ }, create, clear() {}, destroy: vi.fn(),
    imageTableRange(texture: Texture) { return texture === image ? range : undefined },
    pass() {
      if (!inject) return
      inject = false; held = renderer.acquire({ x: 0, y: 0, w: 8, h: 8 })
      expect(renderer.staticImageBlurs.stage(source, 'already-certified-control-fixture', held!.rect, held, driver.resourceEpoch)).toBe(true)
    },
    async finish() { if (fail) throw Error('finish rejected'); driver.completedResourceEpoch = driver.resourceEpoch; return {} },
    async abortFrameAndReleaseFilterScratch() { driver.completedResourceEpoch = driver.resourceEpoch }, dispose: vi.fn(),
  } as unknown as Driver & { resourceEpoch: number; completedResourceEpoch: number }
  const renderer = new GpuRenderer(driver, true, false) as any
  // This seam isolates publication/retirement. Native admission itself is
  // covered by the actual coordinate/plan fixtures above, not this injected plane.
  const source = renderer.staticImageBlurs.registerUpload(image, range, 'actual-upload', 'color/adjust')
  const scene = { version: 7, width: 8, height: 8, extent: { x: 0, y: 0, w: 8, h: 8 }, floatCompositing: true,
    coherentSamples: true, background: '#ffffff', transparent: false, grid: false,
    view: { x: 0, y: 0, zoom: 1 }, roots: [], nodes: {}, vertices: [] } as GpuScene
  return { renderer, driver, scene, source, get held() { return held! }, current: () => current,
    fail() { fail = true }, cancel() { current = false } }
}
test('actual render publication protects completed cache storage from its final busy sweep', async () => {
  const f = lifecycleFixture(); await f.renderer.render(f.scene, false, false, f.current)
  expect(f.renderer.staticImageBlurs.has(f.held.texture)).toBe(true)
  expect(f.renderer.busy.has(f.held.texture)).toBe(true)
  const hit = f.renderer.staticImageBlurs.borrow(f.source, 'already-certified-control-fixture', f.held.rect, f.held.rect,
    f.driver.completedResourceEpoch, f.driver.resourceEpoch)
  expect(hit).toBeDefined(); hit.release()
  f.renderer.dispose(); expect(f.driver.dispose).toHaveBeenCalledOnce()
  expect(f.renderer.staticImageBlurs.bytes).toBe(0); expect(f.renderer.busy.size).toBe(0)
})
test('a failed actual finish cannot publish or pool an unfenced candidate', async () => {
  const f = lifecycleFixture(); f.fail()
  await expect(f.renderer.render(f.scene, false, false, f.current)).rejects.toThrow('finish rejected')
  expect(f.renderer.staticImageBlurs.count).toBe(0)
  expect(f.renderer.staticImageBlurs.has(f.held.texture)).toBe(true)
  expect(f.renderer.busy.has(f.held.texture)).toBe(true)
  expect(f.driver.destroy).not.toHaveBeenCalledWith(f.held.texture)
  await f.driver.abortFrameAndReleaseFilterScratch!('cancel')
  f.renderer.staticImageBlurs.collect(f.driver.completedResourceEpoch)
  expect(f.renderer.staticImageBlurs.has(f.held.texture)).toBe(false)
  expect(f.renderer.busy.has(f.held.texture)).toBe(false)
})
