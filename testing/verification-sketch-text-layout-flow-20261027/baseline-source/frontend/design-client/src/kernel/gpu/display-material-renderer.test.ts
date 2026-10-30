import { afterEach, expect, test, vi } from 'vitest'
import { GpuRenderer, type Surface } from './renderer'
import { certifyExactImageRange } from './exact-image-x-table'
import { sceneIndex } from './scene-index'
import type { Driver, GpuNode, GpuScene, PathMesh, Rect, Texture } from './types'

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })
function coverage(r: Rect) {
  const first = 1 + r.h * 4, curves = new Float32Array((first + r.h * 12) * 4)
  curves.set([3, 1, r.w, r.h])
  for (let row = 0; row < r.h * 4; row++) {
    curves.set([first + row * 3, 1, 0, 0], 4 + row * 4)
    curves.set([0, r.w, 0, 0], (first + row * 3) * 4)
  }
  return { curves, path: { rect: r, count: 3, first: 0, rule: 'nonzero', sampleCount: 4,
    area: { first: 0, count: curves.length / 4 } } as PathMesh }
}

/** Real renderer admission, blur traversal, cache borrowing, pool and frame
 * publication. The CPU driver queues storage commands: abort discards them
 * while advancing retirement, so completion epoch alone cannot prove pixels
 * were written. Filter arithmetic is an identity terminal transport, and the
 * image paint terminal is an integer crop. Neither is a shader-math oracle. */
function fixture() {
  vi.stubEnv('VITE_DESIGN_DISPLAY_MATERIAL_SOURCE', '1')
  vi.stubEnv('VITE_DESIGN_STATIC_IMAGE_BLUR_CACHE', '0')
  vi.stubEnv('VITE_DESIGN_IMAGE_RESOLVE_FUSION', '0')
  vi.stubEnv('VITE_DESIGN_NESTED_PREFIX', '0')
  vi.stubEnv('VITE_DESIGN_IMAGE_MIPS', '0'); vi.stubEnv('VITE_DESIGN_IMAGE_ATLAS', '0')
  const extent = { x: 20, y: 20, w: 12, h: 8 }, shape = { x: 0, y: 0, w: 64, h: 64 }, c = coverage(shape)
  const node = { id: 'material', rect: shape, size: [64, 64], matrix: [1, 0, 0, 1, 0, 0], inverse: [1, 0, 0, 1, 0, 0],
    fill: c.path, fills: [{ id: 'image-paint', kind: 'image', image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9sAAAAASUVORK5CYII=', color: '#ffffff',
      fit: 'cover', visible: true, opacity: 1, blend: 'normal', stops: [] }], children: [], strokes: [],
    effects: [{ kind: 'blur', visible: true, radius: 2 }], opacity: 1, blend: 'normal', mask: false, clip: false } as unknown as GpuNode
  const scene: GpuScene = { version: 8, width: extent.w, height: extent.h, extent, output: extent,
    view: { x: 0, y: 0, zoom: 1 }, roots: [node.id], nodes: { [node.id]: node }, vertices: [], curves: c.curves,
    background: '#ffffff', transparent: false, grid: false, floatCompositing: true, coherentSamples: true,
    integratedBlur: true, displayMaterialSource: true }
  const sourcePixels = Float32Array.from({ length: 64 * 64 * 4 }, (_, i) => [.125, .25, .5, 1][i % 4])
  const pixels = new Map<Texture, Float32Array>(), ranges = new WeakMap<Texture, NonNullable<ReturnType<typeof certifyExactImageRange>>>()
  const allocations: Texture[] = [], encodedFilters: number[] = [], executedFilters: number[] = [], preparedScenes: GpuScene[] = []
  let commands: (() => void)[] = [], cancelled = false, beforePaint: ((material?: Surface) => void) | undefined
  const create = (width: number, height: number): Texture => {
    const texture = { width, height, bytes: width * height * 16, resource: { fixtureTextureId: allocations.length } } as unknown as Texture
    allocations.push(texture); pixels.set(texture, new Float32Array(width * height * 4)); return texture
  }
  const read = (texture: Texture | undefined, x: number, y: number, channel: number) => {
    if (!texture || x < 0 || y < 0 || x >= texture.width || y >= texture.height) return 0
    const values = pixels.get(texture)
    if (!values) throw Error('Queued read outlived its texture')
    return values[(y * texture.width + x) * 4 + channel]
  }
  const submit = () => { const pending = commands; commands = []; for (const command of pending) command() }
  const mask = (_path: PathMesh, texture: Texture) => { commands.push(() => pixels.get(texture)!.fill(1)) }
  const driver = { name: 'webgpu', description: 'CPU deferred material transport', managed: true, displayMath: false,
    captureDisplay: true, hdr: false, linearLight: true, lost: false, sequentialSampleResolve: true,
    drawCalls: 0, triangles: 0, resourceEpoch: 0, completedResourceEpoch: 0, scratchBytes: 0,
    create, createBinaryCoverage(width: number, height: number) { const t = create(width, height); t.binaryCoverage = true; return t },
    clear(texture: Texture) { commands.push(() => pixels.get(texture)!.fill(0)) }, mask, maskRegion: mask,
    destroy: vi.fn((texture: Texture) => { pixels.delete(texture); ranges.delete(texture) }),
    uploadLinear(values: Float32Array, width: number, height: number) {
      const texture = create(width, height); pixels.get(texture)!.set(values)
      ranges.set(texture, certifyExactImageRange(values)!); texture.finitePixels = true; return texture
    },
    imageTableRange: (texture: Texture) => ranges.get(texture),
    prepareScene: vi.fn(async (value: GpuScene) => { preparedScenes.push(value) }),
    prepareFilters: vi.fn(async () => undefined),
    begin() { driver.resourceEpoch++ },
    pass(target: Texture, original: Float32Array, sources: Texture[], region?: Rect, _channels?: number, _filter?: unknown, clearOutside?: boolean) {
      expect(sources).not.toContain(target)
      const u = original.slice(), inputs = sources.slice(), mode = u[16], scope = region ? { ...region } : undefined
      if (mode === 22) encodedFilters.push(u[37])
      driver.drawCalls++
      commands.push(() => {
        const out = pixels.get(target)
        if (!out) throw Error('Queued write outlived its texture')
        if (!scope || clearOutside) out.fill(0)
        if (mode === 22) executedFilters.push(u[37])
        const area = scope || { x: 0, y: 0, w: target.width, h: target.height }
        for (let y = area.y; y < area.y + area.h; y++) for (let x = area.x; x < area.x + area.w; x++) for (let ch = 0; ch < 4; ch++) {
          const sample = (index: number) => read(inputs[index], u[0] + x - u[4 + index * 4], u[1] + y - u[5 + index * 4], ch)
          let value: number
          if (mode === 12) value = u[48 + ch]
          else if (mode === 0 || mode === 22) value = sample(0)
          else if (mode === 48) value = Math.fround(Math.fround(sample(0) * .25) + (u[17] ? sample(1) : 0))
          else if (mode === 23) value = inputs.reduce((sum, input) => sum + read(input, u[0] + x - u[4], u[1] + y - u[5], ch), 0) / 4
          else {
            expect([3, 29]).toContain(mode)
            const alpha = read(inputs[0], u[0] + x - u[4], u[1] + y - u[5], 3) * u[18]
            value = sample(0) * u[18] + sample(1) * (1 - alpha)
          }
          out[(y * target.width + x) * 4 + ch] = value
        }
      })
    },
    finish: vi.fn(async (texture: Texture) => { submit(); driver.completedResourceEpoch = driver.resourceEpoch; return { linear: pixels.get(texture)!.slice() } }),
    checkpoint: vi.fn(async () => { submit(); driver.completedResourceEpoch = driver.resourceEpoch }),
    abortFrameAndReleaseFilterScratch: vi.fn(async () => { commands = []; driver.completedResourceEpoch = driver.resourceEpoch; driver.scratchBytes = 0 }),
    dispose: vi.fn(),
  } as unknown as Driver & { resourceEpoch: number; completedResourceEpoch: number; scratchBytes: number; hdr: boolean }
  const renderer = new GpuRenderer(driver, true, false, () => ({ width: 64, height: 64, pixels: sourcePixels })) as any
  const kernel = { texture: create(1, 1), rect: { x: 0, y: 0, w: 1, h: 1 } }
  // Coefficient encoding and image shading are deliberately terminal doubles;
  // cache admission, stream/blur traversal, borrowing and finish are real.
  renderer.filterKernel = () => kernel; renderer.certifiedKernel = () => undefined
  vi.spyOn(renderer, 'paint').mockImplementation((...args: unknown[]) => {
    const [paintNode, paint, _mask, material] = args as [GpuNode, GpuNode['fills'][number], Surface, Surface | undefined]
    beforePaint?.(material)
    const source = material || renderer.imageFor(paint.image, 0, false)
    return renderer.run(0, paintNode.rect, [source])
  })
  const run = (readback = false, present = true, value = scene) => renderer.render(value, readback, present, () => !cancelled)
  return { renderer, driver, scene, node, pixels, allocations, encodedFilters, executedFilters, preparedScenes, run,
    pendingCommands: () => commands.length,
    cancel(value = true) { cancelled = value }, beforePaint(callback?: (material?: Surface) => void) { beforePaint = callback } }
}

test('abandoning an unsubmitted new blur clears its provisional cache even when abort advances completedEpoch; the next frame rebuilds', async () => {
  const f = fixture(); let provisional: Surface | undefined
  f.beforePaint(material => {
    expect(material).toBeDefined(); provisional = material
    expect(f.renderer.displayMaterial.published).toBe(false)
    expect(f.executedFilters).toEqual([]); expect(f.pendingCommands()).toBeGreaterThan(0)
    f.cancel(); f.beforePaint(undefined)
  })
  await expect(f.run()).rejects.toThrow('PREVIEW_CANCELLED')
  expect(provisional).toBeDefined(); expect(f.encodedFilters).toEqual([0, 1]); expect(f.executedFilters).toEqual([])
  expect(f.driver.finish).not.toHaveBeenCalled()
  expect(f.driver.abortFrameAndReleaseFilterScratch).toHaveBeenCalledExactlyOnceWith('cancel')
  expect(f.driver.completedResourceEpoch).toBe(f.driver.resourceEpoch)
  expect(f.pendingCommands()).toBe(0); expect(f.renderer.displayMaterial).toBeUndefined()
  expect(f.renderer.displayMaterialBorrowed).toBe(false); expect(f.renderer.frameCurrent).toBeUndefined()
  f.cancel(false)
  const result = await f.run()
  expect(f.encodedFilters).toEqual([0, 1, 0, 1]); expect(f.executedFilters).toEqual([0, 1])
  expect(f.renderer.memoryPolicy().displayMaterialBuilds).toBe(2)
  expect(f.renderer.displayMaterial.published).toBe(true)
  expect([...result.linear.slice(0, 4)]).toEqual([.125, .25, .5, 1])
})

test('cancel after borrowing an already published cache keeps its completed pixels and does not rebuild on the next frame', async () => {
  const f = fixture(), first = await f.run(), cached = f.renderer.displayMaterial
  expect(cached?.published).toBe(true)
  const stored = f.pixels.get(cached.surface.texture)!.slice()
  f.beforePaint(() => { f.cancel(); f.beforePaint(undefined) })
  await expect(f.run()).rejects.toThrow('PREVIEW_CANCELLED')
  expect(f.driver.abortFrameAndReleaseFilterScratch).toHaveBeenCalledExactlyOnceWith('cancel')
  expect(f.renderer.displayMaterial).toBe(cached); expect(f.renderer.displayMaterialBorrowed).toBe(false)
  expect(f.pixels.get(cached.surface.texture)).toEqual(stored)
  expect(vi.mocked(f.driver.destroy).mock.calls.some(([texture]) => texture === cached.surface.texture)).toBe(false)
  f.cancel(false)
  expect((await f.run()).linear).toEqual(first.linear)
  expect(f.encodedFilters).toEqual([0, 1]); expect(f.renderer.memoryPolicy().displayMaterialBuilds).toBe(1)
})

test('pressure during a borrowed material sample cannot retire, pool or destroy the current sampling source', async () => {
  const f = fixture(); await f.run(); const cached = f.renderer.displayMaterial
  let checked = false
  f.beforePaint(material => {
    f.beforePaint(undefined); checked = true
    expect(material).toBe(cached.surface); expect(f.renderer.displayMaterialBorrowed).toBe(true)
    expect(f.renderer.overBudget(f.renderer.frameBudget + 1)).toBe(true)
    expect(f.renderer.displayMaterial).toBe(cached)
    expect(f.renderer.busy.has(cached.surface.texture)).toBe(true)
    expect([...f.renderer.free.values()].flat()).not.toContain(cached.surface.texture)
    expect(vi.mocked(f.driver.destroy).mock.calls.some(([texture]) => texture === cached.surface.texture)).toBe(false)
  })
  await f.run()
  expect(checked).toBe(true); expect(f.renderer.displayMaterialBorrowed).toBe(false)
  expect(f.encodedFilters).toEqual([0, 1])
})

test.each(['readback', 'not-present', 'hdr'] as const)('%s retires the display material and reaches the ordinary graph with candidate disabled', async boundary => {
  const f = fixture(); await f.run(); const cached = f.renderer.displayMaterial
  if (boundary === 'hdr') f.driver.hdr = true
  await f.run(boundary === 'readback', boundary !== 'not-present')
  expect(f.scene.displayMaterialSource).toBe(true) // Caller-owned scene is not changed.
  expect(f.preparedScenes.at(-1)?.displayMaterialSource).toBe(false)
  expect(f.renderer.scene.displayMaterialSource).toBe(false)
  expect(f.renderer.displayMaterial).toBeUndefined()
  expect(f.renderer.busy.has(cached.surface.texture)).toBe(false)
  expect(f.renderer.memoryPolicy().displayMaterialBuilds).toBe(1)
  expect(f.encodedFilters.length).toBeGreaterThan(2) // Exact-output graph really ran.
})

test('the same retained root and source index reuse one arithmetic domain, then retire its planes before exact readback', async () => {
  const f = fixture()
  Object.assign(f.scene, { displayMaterialSource: false, displayFilters: true, displayFilterRadiusLimit: 32,
    interactionRetained: true, interactionLease: {} })
  Object.assign(f.driver, { supportsDisplayFilters: true, usesDisplayFilter: (radius: number, channels = 15) =>
    f.preparedScenes.at(-1)?.displayFilters === true && radius > 0 && radius <= 32 && channels === 15 })
  const sourceIndex = sceneIndex(f.scene), originalScene = f.scene
  await f.run()
  const retained = f.renderer.interactionRoots.get(f.node) as { planes: Surface[] }
  expect(retained).toBeDefined(); expect(retained.planes).toHaveLength(4)
  const oldTextures = new Set(retained.planes.map(plane => plane.texture)), filters = f.encodedFilters.length
  expect(filters).toBeGreaterThan(0)
  for (const texture of oldTextures) expect(f.renderer.interactionTextures.has(texture)).toBe(true)

  // Same object, topology, camera and arithmetic: the normal warmed cache is
  // still useful. No blanket per-frame cache flush can satisfy this test.
  await f.run()
  expect(f.renderer.interactionRoots.get(f.node)).toBe(retained)
  expect(f.renderer.interactionHits).toBe(1); expect(f.encodedFilters).toHaveLength(filters)
  expect(vi.mocked(f.driver.destroy).mock.calls.some(([texture]) => oldTextures.has(texture))).toBe(false)

  const retired: Texture[] = [], originalDestroy = vi.mocked(f.driver.destroy).getMockImplementation()!
  vi.mocked(f.driver.destroy).mockImplementation(texture => {
    if (oldTextures.has(texture)) {
      // The established completed-frame retirement boundary is still used:
      // no new encoder is active and no deferred read still owns these planes.
      expect(f.driver.completedResourceEpoch).toBe(f.driver.resourceEpoch)
      expect(f.pendingCommands()).toBe(0)
      retired.push(texture)
    }
    originalDestroy(texture)
  })
  await f.run(true)
  expect(f.scene).toBe(originalScene)
  expect(f.scene.displayFilters).toBe(true); expect(f.scene.displayFilterRadiusLimit).toBe(32)
  expect(sceneIndex(f.renderer.scene)).toBe(sourceIndex)
  expect(f.preparedScenes.at(-1)).toMatchObject({ displayFilters: false, displayFilterRadiusLimit: undefined })
  expect(new Set(retired)).toEqual(oldTextures); expect(retired).toHaveLength(oldTextures.size)
  for (const texture of oldTextures) {
    expect(f.pixels.has(texture)).toBe(false)
    expect(f.renderer.interactionTextures.has(texture)).toBe(false)
  }
  expect(f.renderer.interactionRoots.get(f.node)).not.toBe(retained)
  expect(f.renderer.interactionHits).toBe(0)
  expect(f.encodedFilters.length).toBeGreaterThan(filters)
})
