import { afterEach, expect, test, vi } from 'vitest'
import { GpuRenderer, type Surface } from './renderer'
import type { Driver, GpuNode, GpuPaint, GpuScene, PathMesh, Rect, Texture } from './types'

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

/** Production renderer and planner, with deferred CPU texture transport.
 * Masks and finite paint/blend arithmetic below are terminal doubles; these
 * tests establish ownership, ordering, crop transport and publication, never
 * native shader precision, GPU memory admission or motion clarity. */
function fixture({ height = 513, nested = true }: { height?: number; nested?: boolean } = {}) {
  vi.stubEnv('VITE_DESIGN_NESTED_PREFIX', '0')
  vi.stubEnv('VITE_DESIGN_STATIC_IMAGE_BLUR_CACHE', '0')
  vi.stubEnv('VITE_DESIGN_DISPLAY_MATERIAL_SOURCE', '0')
  const output: Rect = { x: 20, y: 30, w: 8, h: height }, bounds: Rect = { x: 0, y: 0, w: 64, h: height + 64 }
  const curves = new Float32Array(56); curves.set([4, 0, bounds.w, bounds.h])
  curves.set([4, 0, bounds.w, bounds.h], 28); curves[32] = 1
  const owners = new WeakMap<PathMesh, string>()
  const node = (id: string, children: string[] = [], painted = true, opacity = 1): GpuNode => {
    const fill: PathMesh = { rect: { ...bounds }, count: painted ? 3 : 0, first: 0,
      rule: 'nonzero', sampleCount: 4, ...(painted ? { area: { first: 0, count: 7 } } : {}) }
    owners.set(fill, id)
    return { id, rect: { ...bounds }, size: [64, height + 64], matrix: [1.25, 0, 0, 1.25, .125, -.375],
      inverse: [.8, 0, 0, .8, -.1, .3], fill, fills: painted ? [{ id: `${id}-paint`, kind: 'solid',
        color: id, visible: true, blend: 'normal', opacity: 1, stops: [], angle: 0, fit: 'cover' } as GpuPaint] : [],
      children, strokes: [], effects: [], opacity, blend: 'normal', mask: false, clip: false }
  }
  const root = node('root', nested ? ['a', 'group', 'top'] : [], !nested)
  const a = node('a'), group = node('group', ['b'], true, .5), b = node('b'), top = node('top')
  top.fill.area!.first = 7 // Distinct outline identity for the distinct terminal silhouette.
  const nodes: Record<string, GpuNode> = nested ? { root, a, group, b, top } : { root }
  const scene: GpuScene = { version: 8, width: output.w, height: output.h, extent: { ...bounds }, output,
    floatCompositing: true, coherentSamples: true, integratedBlur: true, sequentialDisplay: true,
    background: 'background', transparent: false, grid: false, view: { x: -.125, y: .375, zoom: 1.25 },
    colors: { background: [.125, .25, .5, 1], root: [.75, .25, .125, .75],
      a: [1, 0, 0, .5], group: [0, 1, 0, .5], b: [0, 0, 1, .5], top: [1, 1, 0, .25] },
    roots: [root.id], nodes, vertices: [], curves }
  const pixels = new Map<Texture, Float32Array>(), allocations: Texture[] = []
  const preparedScenes: GpuScene[] = [], copies: { source: Texture; target: Texture; region: Rect; origin: number[] }[] = []
  const masks: { path: PathMesh; region: Rect; sample: number | undefined }[] = []
  const paints: { node: GpuNode; paint: GpuPaint; sample: number | undefined }[] = []
  let commands: (() => void)[] = [], cancelled = false, onCopy: (() => void) | undefined
  let presented: Float32Array | undefined
  const create = (width: number, height: number): Texture => {
    const texture = { width, height, bytes: width * height * 16,
      resource: { textureId: allocations.length } } as unknown as Texture
    allocations.push(texture); pixels.set(texture, new Float32Array(width * height * 4)); return texture
  }
  const values = (texture: Texture) => {
    const value = pixels.get(texture)
    if (!value) throw Error('Deferred command used a destroyed texture')
    return value
  }
  const read = (texture: Texture | undefined, x: number, y: number, channel: number) => {
    if (!texture) return 0
    if (texture.transparentZero) return 0
    if (texture.uniformColor) return values(texture)[channel]
    if (x < 0 || y < 0 || x >= texture.width || y >= texture.height) return 0
    return values(texture)[(y * texture.width + x) * 4 + channel]
  }
  const submit = () => { const pending = commands; commands = []; for (const command of pending) command() }
  const mask = (path: PathMesh, texture: Texture, sample?: number, region = path.rect) => {
    masks.push({ path, region: { ...region }, sample })
    const owner = owners.get(path)
    commands.push(() => {
      const data = values(texture)
      for (let y = 0; y < texture.height; y++) for (let x = 0; x < texture.width; x++) {
        // A deterministic sample-dependent silhouette exercises all four
        // planes and the seam between two independently rendered bands.
        const covered = owner !== 'top' || ((region.x + x + region.y + y + (sample || 0)) % 3 !== 0)
        data.fill(covered ? 1 : 0, (y * texture.width + x) * 4, (y * texture.width + x + 1) * 4)
      }
    })
  }
  const driver = { name: 'webgpu', description: 'Deferred sequential transport', managed: true, displayMath: false,
    hdr: false, captureDisplay: true, lost: false, linearLight: true, sequentialSampleResolve: true,
    drawCalls: 0, triangles: 0, resourceEpoch: 0, completedResourceEpoch: 0, scratchBytes: 0,
    create, createBinaryCoverage(width: number, height: number) {
      const texture = create(width, height); texture.binaryCoverage = true; texture.bytes = width * height * 4; return texture
    },
    destroy: vi.fn((texture: Texture) => { pixels.delete(texture) }),
    clear(texture: Texture) { commands.push(() => values(texture).fill(0)) }, mask, maskRegion: mask,
    prepareScene: vi.fn(async (value: GpuScene) => { preparedScenes.push(value) }),
    begin() { driver.resourceEpoch++ },
    pass(target: Texture, original: Float32Array, inputs: Texture[], region?: Rect, _channels?: number,
      _filter?: unknown, clearOutside?: boolean) {
      expect(inputs).not.toContain(target)
      const u = original.slice(), sources = inputs.slice(), mode = u[16], scope = region && { ...region }
      expect([0, 3, 12, 23, 29, 48, 91]).toContain(mode)
      driver.drawCalls++
      commands.push(() => {
        const out = values(target)
        if (!scope || clearOutside) out.fill(0)
        const area = scope || { x: 0, y: 0, w: target.width, h: target.height }
        for (let y = area.y; y < area.y + area.h; y++) for (let x = area.x; x < area.x + area.w; x++) for (let ch = 0; ch < 4; ch++) {
          const sample = (index: number, channel = ch) => {
            const slot = index === 3 ? 0 : index
            return read(sources[index], u[0] + x - u[4 + slot * 4], u[1] + y - u[5 + slot * 4], channel)
          }
          let value: number
          if (mode === 12) value = u[48 + ch]
          else if (mode === 0) value = sample(0)
          else if (mode === 91) {
            const alpha = Math.fround(Math.fround(u[51] * u[18]) * sample(0, 3))
            value = ch === 3 ? alpha : Math.fround(u[48 + ch] * alpha)
          } else if (mode === 48) value = Math.fround((u[17] ? sample(1) : 0) + Math.fround(sample(0) * .25))
          else if (mode === 23) {
            value = Math.fround(sample(0) * .25)
            for (let i = 1; i < 4; i++) value = Math.fround(value + Math.fround(sample(i) * .25))
          } else {
            const alpha = Math.fround(sample(0, 3) * u[18])
            value = Math.fround(Math.fround(sample(0) * u[18]) + Math.fround(sample(1) * Math.fround(1 - alpha)))
          }
          out[(y * target.width + x) * 4 + ch] = value
        }
      })
    },
    copyRegion(target: Texture, source: Texture, region: Rect, origin: [number, number]) {
      expect(target).not.toBe(source)
      copies.push({ target, source, region: { ...region }, origin: [...origin] })
      commands.push(() => {
        const out = values(target)
        for (let y = 0; y < region.h; y++) for (let x = 0; x < region.w; x++) for (let ch = 0; ch < 4; ch++)
          out[((origin[1] + y) * target.width + origin[0] + x) * 4 + ch] = read(source, region.x + x, region.y + y, ch)
      })
      onCopy?.()
    },
    finish: vi.fn(async (texture: Texture, sourceRect: Rect, width: number, height: number, _readback: boolean,
      _preview: unknown, present: boolean, outputRect?: Rect) => {
      submit(); driver.completedResourceEpoch = driver.resourceEpoch
      // Match the driver's terminal viewport mapping. Ordinary composition
      // may retain a halo-sized source, while sequential composition owns
      // just outputRect. Compare the same global output pixels, including
      // every pixel on either side of a band seam, never unlike allocations.
      const output = outputRect || { x: 0, y: 0, w: width, h: height }
      expect(output.w).toBe(width); expect(output.h).toBe(height)
      const linear = new Float32Array(width * height * 4)
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let ch = 0; ch < 4; ch++)
        linear[(y * width + x) * 4 + ch] = read(texture, output.x + x - sourceRect.x, output.y + y - sourceRect.y, ch)
      if (present) presented = linear.slice()
      return { linear }
    }),
    checkpoint: vi.fn(async () => { submit(); driver.completedResourceEpoch = driver.resourceEpoch }),
    abortFrameAndReleaseFilterScratch: vi.fn(async () => {
      commands = []; driver.completedResourceEpoch = driver.resourceEpoch; driver.scratchBytes = 0
    }), dispose: vi.fn(),
  } as unknown as Driver & { resourceEpoch: number; completedResourceEpoch: number; scratchBytes: number; hdr: boolean }
  const renderer = new GpuRenderer(driver, true, false) as any
  vi.spyOn(renderer, 'paint').mockImplementation((...args: unknown[]) => {
    const [n, paint, coverage] = args as [GpuNode, GpuPaint, Surface]
    paints.push({ node: n, paint, sample: renderer.sampleIndex })
    return renderer.run(91, n.rect, [coverage], (u: Float32Array) => {
      u.set(scene.colors![paint.color], 48); u[18] = paint.opacity
    })
  })
  return { renderer, driver, scene, root, pixels, copies, masks, paints, preparedScenes,
    run: (readback = false, present = true, value = scene) => renderer.render(value, readback, present, () => !cancelled),
    cancel(value = true) { cancelled = value }, submit,
    onCopy(callback?: () => void) { onCopy = callback },
    pending: () => commands.length, presented: () => presented?.slice() }
}

test('sequential bands preserve isolation/painter order and exact deferred transport across the band seam', async () => {
  const normal = fixture(), sequential = fixture(), before = structuredClone(sequential.scene)
  const normalResult = await normal.run(false, true, { ...normal.scene, sequentialDisplay: false })
  const result = await sequential.run()
  expect(new Uint32Array(result.linear.buffer)).toEqual(new Uint32Array(normalResult.linear.buffer))
  expect(sequential.copies.map(copy => [copy.region, copy.origin])).toEqual([
    [{ x: 0, y: 0, w: 8, h: 512 }, [0, 0]], [{ x: 0, y: 0, w: 8, h: 1 }, [0, 512]],
  ])
  expect(sequential.copies.every(copy => copy.target.width === 8 && copy.target.height === 513)).toBe(true)
  expect(sequential.paints.map(call => call.paint.color)).toEqual(Array.from({ length: 8 }, () => ['a', 'group', 'b', 'top']).flat())
  expect(sequential.scene).toEqual(before)
  for (const call of sequential.masks) {
    expect(Object.values(sequential.scene.nodes).some(node => node.fill === call.path)).toBe(true)
    expect(call.path.rect).toEqual({ x: 0, y: 0, w: 64, h: 577 })
    expect(call.region.h).toBeLessThanOrEqual(512)
  }
  for (const call of sequential.paints) {
    const source = sequential.scene.nodes[call.node.id]
    expect(call.node.matrix).toBe(source.matrix); expect(call.node.inverse).toBe(source.inverse)
    expect(call.node.fill).toBe(source.fill)
  }
  expect(sequential.renderer.memoryPolicy().sequentialDisplayFrames).toBe(1)
  expect(sequential.driver.finish).toHaveBeenCalledTimes(1)
})

test('cancel after a submitted first band never publishes a partial replacement or destroys deferred inputs', async () => {
  const f = fixture(), first = await f.run(), shown = f.presented(), finishes = vi.mocked(f.driver.finish).mock.calls.length
  let interrupted = false
  f.onCopy(() => {
    if (interrupted) return
    interrupted = true; f.submit(); f.cancel() // Simulate a queue-arena submission before cancellation.
  })
  await expect(f.run()).rejects.toThrow('PREVIEW_CANCELLED')
  expect(interrupted).toBe(true)
  expect(f.driver.finish).toHaveBeenCalledTimes(finishes)
  expect(f.driver.abortFrameAndReleaseFilterScratch).toHaveBeenCalledExactlyOnceWith('cancel')
  expect(f.pending()).toBe(0); expect(f.presented()).toEqual(shown)
  expect(f.renderer.frameCurrent).toBeUndefined(); expect(f.renderer.sampleIndex).toBeUndefined()
  f.cancel(false); f.onCopy(undefined)
  expect((await f.run()).linear).toEqual(first.linear)
})

test.each(['readback', 'not-present', 'hdr'] as const)('%s clears sequential display and executes the ordinary graph without mutating caller input', async boundary => {
  const f = fixture({ height: 8, nested: false })
  if (boundary === 'hdr') f.driver.hdr = true
  await f.run(boundary === 'readback', boundary !== 'not-present')
  expect(f.scene.sequentialDisplay).toBe(true)
  expect(f.preparedScenes.at(-1)?.sequentialDisplay).toBe(false)
  expect(f.copies).toHaveLength(0)
  expect(f.renderer.memoryPolicy().sequentialDisplayFrames).toBe(0)
  expect(f.driver.finish).toHaveBeenCalledTimes(1)
})

test('entering sequential arithmetic retires old retained roots at the completed boundary before any new band reads', async () => {
  const f = fixture({ height: 8, nested: false })
  await f.run(false, true, { ...f.scene, sequentialDisplay: false, interactionRetained: true, interactionLease: {} })
  const retained = f.renderer.interactionRoots.get(f.root) as { planes: Surface[] }
  expect(retained).toBeDefined()
  const oldTextures = new Set(retained.planes.map(plane => plane.texture)), retired: Texture[] = []
  const destroy = vi.mocked(f.driver.destroy).getMockImplementation()!
  vi.mocked(f.driver.destroy).mockImplementation(texture => {
    if (oldTextures.has(texture)) {
      expect(f.pending()).toBe(0)
      expect(f.driver.completedResourceEpoch).toBe(f.driver.resourceEpoch)
      retired.push(texture)
    }
    destroy(texture)
  })
  await f.run()
  expect(new Set(retired)).toEqual(oldTextures)
  expect(f.renderer.interactionRoots.size).toBe(0)
  for (const texture of oldTextures) {
    expect(f.pixels.has(texture)).toBe(false)
    expect(f.renderer.interactionTextures.has(texture)).toBe(false)
  }
})
