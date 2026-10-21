import { afterEach, expect, test, vi } from 'vitest'
import { GpuRenderer, type Surface } from './renderer'
import { planNestedPrefix } from './nested-prefix-plan'
import type { Driver, GpuNode, GpuScene, Rect, Texture } from './types'

afterEach(() => vi.unstubAllEnvs())

/** CPU storage transport for the real renderer cache/alias/scissor lifecycle.
 * Leaf shading is a deterministic terminal contribution, not a GPU math oracle.
 * The original four-plane graph, copy/merge, prefix planning and frame lifecycle
 * execute unchanged; no cache admission or drawRegion method is mocked. */
function fixture(enabled = true) {
  vi.stubEnv('VITE_DESIGN_NESTED_PREFIX', enabled ? '1' : '0')
  const extent = { x: 0, y: 0, w: 48, h: 24 }
  const makeNode = (id: string, children: string[] = []): GpuNode => ({ id, rect: { ...extent },
    matrix: [1, 0, 0, 1, 0, 0], inverse: [1, 0, 0, 1, 0, 0], size: [48, 24],
    fill: { rect: { ...extent }, first: 0, count: 0, rule: 'nonzero' }, children,
    fills: [], strokes: [], effects: [], opacity: 1, blend: 'normal', mask: false, clip: false })
  const nodes = { root: makeNode('root', ['static', 'moving']), static: makeNode('static'), moving: makeNode('moving') }
  nodes.root.previewDynamic = true
  nodes.static.effects = [{ kind: 'blur', visible: true, radius: 3 }] as GpuNode['effects']
  nodes.moving.rect = { x: 8, y: 8, w: 2, h: 2 }
  const scene: GpuScene = { version: 8, width: 48, height: 24, output: { ...extent }, extent,
    view: { x: 0, y: 0, zoom: 1 }, roots: ['root'], nodes, vertices: [], curves: [],
    background: '#ffffff', transparent: false, grid: false, floatCompositing: true,
    coherentSamples: true, integratedBlur: true, interactionRetained: true, nativeInteraction: true,
    interactionLease: {}, interactionSelection: ['moving'], interactionWindow: { x: 6, y: 6, w: 8, h: 8 } }
  const pixels = new Map<Texture, Float32Array>(), allocations: Texture[] = []
  let failFinish = false, cancel = false, failStatic = false
  let beforeMoving: (() => void | Promise<void>) | undefined
  const create = (width: number, height: number): Texture => {
    const texture = { width, height, bytes: width * height * 16, resource: {} } as Texture
    allocations.push(texture); pixels.set(texture, new Float32Array(width * height * 4)); return texture
  }
  const read = (texture: Texture, x: number, y: number, channel: number) =>
    x < 0 || y < 0 || x >= texture.width || y >= texture.height ? 0 : pixels.get(texture)![(y * texture.width + x) * 4 + channel]
  const driver = { name: 'webgpu', description: 'CPU prefix ownership transport', managed: true,
    displayMath: true, captureDisplay: true, drawCalls: 0, triangles: 0, lost: false,
    resourceEpoch: 0, completedResourceEpoch: 0, scratchBytes: 0,
    create, clear(texture: Texture) { pixels.get(texture)!.fill(0) },
    destroy: vi.fn((texture: Texture) => { pixels.delete(texture) }),
    begin() { driver.resourceEpoch++ },
    pass(target: Texture, u: Float32Array, inputs: Texture[], region?: Rect, _channels?: number, _filter?: unknown, clearOutside?: boolean) {
      const output = pixels.get(target)!, mode = u[16]
      expect(inputs).not.toContain(target)
      if (!region || clearOutside) output.fill(0)
      const r = region || { x: 0, y: 0, w: target.width, h: target.height }
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) for (let c = 0; c < 4; c++) {
        const source = (index: number) => read(inputs[index], u[0] + x - u[4 + index * 4], u[1] + y - u[5 + index * 4], c)
        let value: number
        if (mode === 12) value = u[48 + c]
        else if (mode === 0) value = source(0)
        else if (mode === 23) value = inputs.reduce((sum, input) =>
          sum + read(input, u[0] + x - u[4], u[1] + y - u[5], c), 0) / 4
        else {
          expect([3, 29]).toContain(mode)
          const alpha = read(inputs[0], u[0] + x - u[4], u[1] + y - u[5], 3) * u[18]
          value = source(0) * u[18] + source(1) * (1 - alpha)
        }
        output[(y * target.width + x) * 4 + c] = value
      }
    },
    async finish(texture: Texture) {
      if (failFinish) throw Error('finish rejected')
      driver.completedResourceEpoch = driver.resourceEpoch
      return { linear: pixels.get(texture)!.slice() }
    },
    checkpoint: vi.fn(async () => { driver.completedResourceEpoch = driver.resourceEpoch - 1 }),
    abortFrameAndReleaseFilterScratch: vi.fn(async () => {
      driver.completedResourceEpoch = driver.resourceEpoch; driver.scratchBytes = 0
    }),
    dispose: vi.fn(),
  } as unknown as Driver & { resourceEpoch: number; completedResourceEpoch: number; scratchBytes: number }
  const renderer = new GpuRenderer(driver, true, false) as any
  const staticDraws: (Rect | undefined)[] = []
  vi.spyOn(renderer, 'streamIsolatedFilter').mockImplementation(async (...args: unknown[]) => {
    const [node, targets] = args as [GpuNode, Surface[]]
    if (node.id === 'root') return undefined
    if (node.id === 'static') {
      staticDraws.push(renderer.drawRegion(extent))
      if (failStatic) throw Error('static contribution rejected')
      const result = targets.map((target, sample) => {
        const out = renderer.run(12, target.rect, [], (u: Float32Array) => u.set([.125 + sample / 16, .25, .5, 1], 48))
        renderer.release(target); return out
      })
      return result
    }
    await beforeMoving?.()
    return targets.map(target => {
      const contribution = renderer.run(12, node.rect, [], (u: Float32Array) => u.set([1, 0, 0, 1], 48))
      const next = renderer.merge(contribution, target)
      renderer.release(contribution); return next
    })
  })
  const run = (value = scene) => renderer.render(value, true, false, () => !cancel)
  return { scene, nodes, renderer, driver, pixels, allocations, staticDraws, run,
    failFinish() { failFinish = true }, failStatic() { failStatic = true }, cancel() { cancel = true },
    beforeMoving(callback: () => void | Promise<void>) { beforeMoving = callback } }
}

test('actual nested wrapper retains complete static support when the next pose exposes a larger window', async () => {
  const cached = fixture(true)
  await cached.run()
  expect(cached.staticDraws).toEqual([undefined])
  expect(cached.renderer.nestedPrefix).toBeDefined()
  const saved = cached.renderer.nestedPrefix.planes.map((surface: Surface) => cached.pixels.get(surface.texture)!.slice())
  const moved: GpuScene = { ...cached.scene, interactionWindow: { x: 6, y: 6, w: 28, h: 8 },
    nodes: { ...cached.nodes, moving: { ...cached.nodes.moving, rect: { x: 28, y: 8, w: 2, h: 2 } } } }
  const actual = await cached.run(moved)
  expect(cached.staticDraws).toHaveLength(1)
  expect(cached.renderer.prefixHits).toBe(1)
  expect(cached.renderer.nestedPrefix.planes.map((surface: Surface) => cached.pixels.get(surface.texture))).toEqual(saved)
  const uncached = fixture(false)
  const reference = await uncached.run({ ...uncached.scene, interactionWindow: moved.interactionWindow,
    nodes: { ...uncached.nodes, moving: { ...uncached.nodes.moving, rect: moved.nodes.moving.rect } } })
  expect(actual.linear).toEqual(reference.linear)
  expect(actual.linear[(8 * 48 + 20) * 4 + 1]).toBe(.25)
})

test('a changed static source, lease, camera or target lattice rebuilds instead of borrowing old pixels', async () => {
  for (const kind of ['source', 'lease', 'camera', 'extent'] as const) {
    const f = fixture(); await f.run()
    const next = { ...f.scene, nodes: { ...f.nodes } }
    if (kind === 'source') next.nodes.static = { ...next.nodes.static }
    if (kind === 'lease') next.interactionLease = {}
    if (kind === 'camera') next.view = { ...next.view, x: .125 }
    if (kind === 'extent') next.extent = { ...next.extent, w: next.extent.w + 1 }
    await f.run(next)
    expect(f.staticDraws).toHaveLength(2)
    expect(f.renderer.prefixHits).toBe(0)
  }
})

test('stored planes remain in the working ledger and retirement returns storage without premature destruction', async () => {
  const f = fixture(); await f.run()
  const planes = f.renderer.nestedPrefix.planes as Surface[]
  const bytes = planes.reduce((total, plane) => total + plane.texture.bytes, 0)
  expect(f.renderer.nestedPrefixBytes).toBe(bytes)
  expect(f.renderer.workingBytes).toBe(f.renderer.bytes - f.renderer.interactionBytes + bytes)
  for (const plane of planes) expect(f.renderer.interactionTextures.has(plane.texture)).toBe(true)
  f.renderer.retireNestedPrefix()
  expect(f.renderer.nestedPrefixBytes).toBe(0)
  for (const plane of planes) {
    expect(f.driver.destroy).not.toHaveBeenCalledWith(plane.texture)
    expect(f.renderer.interactionTextures.has(plane.texture)).toBe(false)
    expect([...f.renderer.free.values()].flat()).toContain(plane.texture)
  }
})

test('cache budget refusal allocates no planes and does not claim residency', () => {
  const f = fixture(), renderer = f.renderer
  renderer.scene = f.scene
  const plan = planNestedPrefix(f.scene, 'root', new Set(['root', 'moving']))!
  const targets = Array.from({ length: 4 }, () => renderer.acquire(f.scene.extent))
  const allocated = f.allocations.length, needed = targets.reduce((n, target) => n + target.texture.bytes, 0)
  renderer.frameBudget = renderer.workingBytes + needed - 1
  renderer.saveNestedPrefix(plan, renderer.nestedPrefixPolicy('root', targets), targets)
  expect(renderer.nestedPrefix).toBeUndefined()
  expect(f.allocations).toHaveLength(allocated)
  renderer.frameBudget = 256 * 1024 * 1024
  renderer.saveNestedPrefix(plan, 'too-large', targets.map(target => ({ ...target, rect: { x: 0, y: 0, w: 2048, h: 2048 } })))
  expect(renderer.nestedPrefix).toBeUndefined()
  expect(f.allocations).toHaveLength(allocated)
})

test('failed finish clears a provisional prefix and keeps its submitted resources alive', async () => {
  const f = fixture(); f.failFinish()
  await expect(f.run()).rejects.toThrow('finish rejected')
  expect(f.renderer.nestedPrefix).toBeUndefined()
  expect(f.renderer.nestedPrefixBytes).toBe(0)
  expect(f.driver.completedResourceEpoch).toBe(0)
  expect(f.driver.destroy).not.toHaveBeenCalled()
  expect(f.renderer.interactionCapturing).toBe(false)
})

test('a static-prefix exception restores the caller capture mode', async () => {
  const f = fixture(); f.failStatic()
  await expect(f.run()).rejects.toThrow('static contribution rejected')
  expect(f.renderer.nestedPrefix).toBeUndefined()
  expect(f.renderer.interactionCapturing).toBe(false)
})

test('pressure retires cached planes into the ordered pool and destroys them only after the pending checkpoint completes', async () => {
  const f = fixture(); await f.run()
  const planes = f.renderer.nestedPrefix.planes as Surface[]
  // Model another submission reading the captured planes. Completion of the
  // earlier successful frame cannot authorize destruction of these new reads.
  f.driver.begin(new Float32Array(), new Float32Array())
  for (const plane of planes) f.renderer.used.add(plane.texture)
  const bytesBefore = f.renderer.bytes, completedBefore = f.driver.completedResourceEpoch
  f.renderer.frameBudget = f.renderer.workingBytes
  let completeCheckpoint!: () => void
  vi.mocked(f.driver.checkpoint!).mockImplementationOnce(async () => {
    await new Promise<void>(resolve => { completeCheckpoint = resolve })
    f.driver.completedResourceEpoch = f.driver.resourceEpoch
  })
  vi.mocked(f.driver.destroy).mockClear()
  const reclaimed = f.renderer.reclaimScratch(1)
  expect(f.driver.checkpoint).toHaveBeenCalledTimes(1)
  expect(f.renderer.nestedPrefixPressure).toBe(true)
  expect(f.renderer.nestedPrefix).toBeUndefined()
  expect(f.renderer.nestedPrefixBytes).toBe(0)
  expect(f.renderer.bytes).toBe(bytesBefore)
  expect(f.driver.completedResourceEpoch).toBe(completedBefore)
  for (const plane of planes) {
    expect([...f.renderer.free.values()].flat()).toContain(plane.texture)
    expect(f.pixels.has(plane.texture)).toBe(true)
    expect(f.driver.destroy).not.toHaveBeenCalledWith(plane.texture)
  }
  completeCheckpoint(); await reclaimed
  expect(f.driver.completedResourceEpoch).toBe(f.driver.resourceEpoch)
  for (const plane of planes) {
    expect(f.driver.destroy).toHaveBeenCalledWith(plane.texture)
    expect(f.pixels.has(plane.texture)).toBe(false)
    expect([...f.renderer.free.values()].flat()).not.toContain(plane.texture)
  }
  expect(f.renderer.bytes).toBeLessThan(bytesBefore)
  expect(f.renderer.workingBytes + 1).toBeLessThanOrEqual(f.renderer.frameBudget)
})

test.each([0, 4096])('a real allocation refusal retries once without optional cache and preserves the %i-byte filter-scratch fallback', async reserved => {
  const f = fixture(), attempts: { nested: boolean; prefix: boolean; cached: boolean }[] = []
  const requiredRect = { x: 0, y: 0, w: 49, h: 24 }
  f.beforeMoving(() => {
    attempts.push({ nested: f.renderer.nestedPrefixAllowed, prefix: f.renderer.prefixAllowed,
      cached: !!f.renderer.nestedPrefix })
    if (attempts.length === 1) {
      expect(f.renderer.nestedPrefix).toBeDefined()
      f.driver.scratchBytes = reserved; f.renderer.bytes += reserved
      // This new size has no pooled allocation. The optional prefix makes
      // its first allocation exceed the unchanged working-memory ledger.
      f.renderer.frameBudget = f.renderer.workingBytes + requiredRect.w * requiredRect.h * 16 - 1
    }
    const surface = f.renderer.acquire(requiredRect)
    f.renderer.release(surface)
  })
  const actual = await f.run()
  expect(attempts).toEqual([
    { nested: true, prefix: true, cached: true },
    { nested: false, prefix: reserved === 0, cached: false },
  ])
  expect(f.staticDraws).toHaveLength(2)
  expect(f.driver.abortFrameAndReleaseFilterScratch).toHaveBeenCalledExactlyOnceWith('admission')
  expect(f.driver.scratchBytes).toBe(0)
  expect(f.renderer.nestedPrefix).toBeUndefined()
  expect(f.renderer.nestedPrefixBytes).toBe(0)
  expect(f.renderer.nestedPrefixAllowed).toBe(true)
  expect(f.renderer.prefixAllowed).toBe(true)
  expect(f.renderer.frameCurrent).toBeUndefined()
  const reference = fixture(false)
  expect(actual.linear).toEqual((await reference.run()).linear)
})

test('a second allocation refusal propagates after the sole cache-disabled retry', async () => {
  const f = fixture(), attempts: boolean[] = []
  f.beforeMoving(() => {
    attempts.push(f.renderer.nestedPrefixAllowed)
    if (attempts.length === 1) {
      expect(f.renderer.nestedPrefix).toBeDefined()
      f.renderer.frameBudget = f.renderer.workingBytes
    }
    // Even with no retained prefix, this single allocation exceeds the whole
    // budget. Actual acquire/overBudget must reject both attempts.
    f.renderer.acquire({ x: 0, y: 0, w: Math.ceil(f.renderer.frameBudget / 16) + 1, h: 1 })
  })
  await expect(f.run()).rejects.toThrow('GPU 表面内存预算超限')
  expect(attempts).toEqual([true, false])
  expect(f.staticDraws).toHaveLength(2)
  expect(f.driver.abortFrameAndReleaseFilterScratch).toHaveBeenCalledExactlyOnceWith('admission')
  expect(f.renderer.nestedPrefix).toBeUndefined()
  expect(f.renderer.nestedPrefixAllowed).toBe(true)
  expect(f.renderer.prefixAllowed).toBe(true)
  expect(f.renderer.frameCurrent).toBeUndefined()
})

test.each(['ordinary', 'cancel'] as const)('recorded prefix pressure does not swallow a subsequent %s failure or start an admission retry', async kind => {
  const f = fixture(), failure = Error('moving contribution rejected')
  f.beforeMoving(async () => {
    expect(f.renderer.nestedPrefix).toBeDefined()
    expect(f.renderer.overBudget(f.renderer.frameBudget + 1)).toBe(true)
    expect(f.renderer.nestedPrefixPressure).toBe(true)
    if (kind === 'ordinary') throw failure
    f.cancel()
    await f.renderer.reclaimScratch()
  })
  if (kind === 'ordinary') await expect(f.run()).rejects.toBe(failure)
  else await expect(f.run()).rejects.toThrow('PREVIEW_CANCELLED')
  expect(f.staticDraws).toHaveLength(1)
  if (kind === 'ordinary') expect(f.driver.abortFrameAndReleaseFilterScratch).not.toHaveBeenCalled()
  else expect(f.driver.abortFrameAndReleaseFilterScratch).toHaveBeenCalledExactlyOnceWith('cancel')
  expect(f.renderer.nestedPrefix).toBeUndefined()
  expect(f.renderer.nestedPrefixAllowed).toBe(true)
  expect(f.renderer.frameCurrent).toBeUndefined()
})

test('a budget refusal during the second optional copy releases the partial cache without changing original targets', () => {
  const f = fixture(), renderer = f.renderer
  renderer.scene = f.scene
  const plan = planNestedPrefix(f.scene, 'root', new Set(['root', 'moving']))!
  const targets: Surface[] = Array.from({ length: 4 }, () => renderer.acquire(f.scene.extent))
  targets.forEach((target, i) => f.pixels.get(target.texture)!.fill(i + .25))
  const originals = targets.map(target => f.pixels.get(target.texture)!.slice())
  const allocated = f.allocations.length, pass = f.driver.pass.bind(f.driver)
  vi.spyOn(f.driver, 'pass').mockImplementation((...args: Parameters<Driver['pass']>) => {
    pass(...args)
    // The first complete copy is real; only tighten available capacity before
    // the next acquire. No copy/admission/cache method is replaced.
    if (args[1][16] === 0) renderer.frameBudget = renderer.workingBytes
  })
  expect(() => renderer.saveNestedPrefix(plan, renderer.nestedPrefixPolicy('root', targets), targets)).not.toThrow()
  expect(f.allocations).toHaveLength(allocated + 1)
  const partial = f.allocations[allocated]
  expect([...renderer.free.values()].flat()).toContain(partial)
  expect(renderer.busy.has(partial)).toBe(false)
  expect(f.driver.destroy).not.toHaveBeenCalled()
  expect(renderer.nestedPrefix).toBeUndefined()
  expect(renderer.nestedPrefixBytes).toBe(0)
  expect(renderer.interactionBytes).toBe(0)
  expect(renderer.interactionCapturing).toBe(false)
  targets.forEach((target, i) => {
    expect(renderer.busy.has(target.texture)).toBe(true)
    expect(f.pixels.get(target.texture)).toEqual(originals[i])
    expect([...renderer.free.values()].flat()).not.toContain(target.texture)
  })
})
