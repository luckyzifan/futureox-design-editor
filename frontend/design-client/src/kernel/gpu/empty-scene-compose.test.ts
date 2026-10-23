import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { emptyManagedComposeScene } from './empty-scene-compose'
import { PipelineRegistry } from './pipeline-registry'
import { GpuRenderer } from './renderer'
import { WebGpuDriver } from './webgpu'
import { parameters, type GpuScene } from './types'

// CPU-only admission/descriptor/command contracts. Production initialize,
// prepareScene, registry and pass dispatch are never replaced. Only the GPU
// and platform boundary below is fake: no WGSL, pixels, timing or arithmetic
// are validated. Run with an isolated Vitest config whose setupFiles is empty;
// the application's default config initializes WASM and a font unnecessarily.
// This file neither initializes nor calls the application WASM kernel.

const peers = ['exactNormal', 'exactPresent', 'exactNormalCorner', 'exactCopyCorner',
  'exactSolidPaintOver', 'exactResolveStep', 'exactShadowOver', 'exactImageResolveStep'] as const
const allCompose = [...peers, 'exactAlphaResolve']
const copies = ['exactPresent', 'exactCopyCorner']
type Descriptor = {
  layout: any
  vertex: { module: any; entryPoint: string }
  fragment: { module: any; entryPoint: string; targets: any[]; constants?: Record<string, number> }
  primitive: { topology: string }
}
type Pipeline = Descriptor & { boundaryId: number }
function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
// Give already runnable promise reactions a complete task turn, without
// resolving any held GPU boundary promise or assuming a microtask depth.
const nextTurn = () => new Promise<void>(resolve => setTimeout(resolve, 0))
function observe(promise: Promise<unknown>) {
  let settled = false
  const result = promise.then(value => { settled = true; return { ok: true as const, value } },
    error => { settled = true; return { ok: false as const, error } })
  return { result, settled: () => settled }
}
function scene(overrides: Record<string, unknown> = {}): GpuScene {
  return {
    version: 8, width: 8, height: 8, output: { x: 0, y: 0, w: 8, h: 8 },
    extent: { x: 0, y: 0, w: 8, h: 8 }, floatCompositing: true,
    coherentSamples: false, integratedBlur: true, background: '#ffffff',
    transparent: false, grid: false, view: { x: 0, y: 0, zoom: 1 },
    roots: [], nodes: {}, vertices: [], ...overrides,
  } as GpuScene
}
function nonemptyScene(): GpuScene {
  const rect = { x: 0, y: 0, w: 8, h: 8 }
  return scene({ roots: ['node'], nodes: { node: {
    id: 'node', rect, matrix: [1, 0, 0, 1, 0, 0], inverse: [1, 0, 0, 1, 0, 0],
    size: [8, 8], fill: { first: 0, count: 0, rect, rule: 'nonzero' },
    fills: [], strokes: [], children: [], effects: [], opacity: 1, blend: 'normal',
  } } })
}
function isCompose(descriptor: Descriptor) {
  const entry = descriptor.fragment.entryPoint, format = descriptor.fragment.targets[0].format
  return allCompose.includes(entry) && format === (entry === 'exactAlphaResolve' ? 'r32float' : 'rgba32float')
}

function deviceBoundary(onPipeline?: (descriptor: Descriptor) => void | Promise<void>) {
  let nextId = 0
  const starts: Descriptor[] = [], completed: Pipeline[] = [], draws: Pipeline[] = []
  const events: { kind: 'start' | 'complete'; entry: string; format: string }[] = []
  const renderPasses: any[] = []
  const device: any = {
    features: new Set(), limits: { maxTextureDimension2D: 16384, minUniformBufferOffsetAlignment: 256 },
    lost: new Promise(() => {}), addEventListener() {},
    createShaderModule: (descriptor: object) => ({ ...descriptor, getCompilationInfo: async () => ({ messages: [] }) }),
    createBindGroupLayout: (descriptor: object) => descriptor,
    createPipelineLayout: (descriptor: object) => descriptor,
    async createRenderPipelineAsync(descriptor: Descriptor) {
      starts.push(descriptor)
      const event = { entry: descriptor.fragment.entryPoint, format: descriptor.fragment.targets[0].format }
      events.push({ kind: 'start', ...event })
      await onPipeline?.(descriptor)
      const pipeline = { ...descriptor, boundaryId: ++nextId }
      completed.push(pipeline); events.push({ kind: 'complete', ...event })
      return pipeline
    },
    createBuffer: ({ size }: { size: number }) => ({ size, destroy() {} }),
    createTexture: ({ size, format }: { size: number[]; format: string }) => {
      const texture = { width: size[0], height: size[1], format, destroy() {}, createView() { return { texture } } }
      return texture
    },
    createBindGroup: (descriptor: any) => descriptor,
    createCommandEncoder() {
      return {
        beginRenderPass(descriptor: any) {
          renderPasses.push(descriptor)
          let pipeline: Pipeline | undefined
          return {
            setPipeline(value: Pipeline) { expect(value).toBeDefined(); pipeline = value },
            setBindGroup() {}, setScissorRect() {}, setVertexBuffer() {}, setStencilReference() {},
            draw() { expect(pipeline).toBeDefined(); draws.push(pipeline!) }, end() {},
          }
        },
        finish: () => ({}),
      }
    },
    pushErrorScope() {}, popErrorScope: async () => null,
    queue: { writeBuffer: vi.fn(), submit: vi.fn(), onSubmittedWorkDone: async () => {} },
  }
  const context = { configure() {}, getConfiguration: () => ({ toneMapping: { mode: 'standard' } }) }
  vi.stubGlobal('GPUShaderStage', { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 })
  vi.stubGlobal('GPUTextureUsage', { TEXTURE_BINDING: 1, RENDER_ATTACHMENT: 2, COPY_SRC: 4, COPY_DST: 8 })
  vi.stubGlobal('GPUBufferUsage', { UNIFORM: 1, STORAGE: 2, COPY_SRC: 4, COPY_DST: 8, VERTEX: 16 })
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(readonly width: number, readonly height: number) {}
    getContext() { return context }
  })
  vi.stubGlobal('navigator', { gpu: {
    requestAdapter: async () => ({ features: new Set(), requestDevice: async () => device }),
    getPreferredCanvasFormat: () => 'rgba8unorm',
  } })
  return { device, starts, completed, events, draws, renderPasses,
    compose: () => starts.filter(isCompose),
    composeEntries: () => starts.filter(isCompose).map(descriptor => descriptor.fragment.entryPoint),
  }
}
function startDriver(options: { managed?: boolean; flag?: string; eager?: boolean;
  onPipeline?: (descriptor: Descriptor) => void | Promise<void> } = {}) {
  vi.stubEnv('VITE_DESIGN_EMPTY_SCENE_COMPOSE', options.flag)
  vi.stubEnv('VITE_DESIGN_LAZY_PIPELINES', options.eager ? '0' : '1')
  const boundary = deviceBoundary(options.onPipeline), managed = options.managed ?? true
  const driver = new WebGpuDriver(managed, false, managed, false)
  const raw = driver as unknown as { initialize(): Promise<void>; pipelines: PipelineRegistry;
    copyPipeline?: Pipeline; copyCornerPipeline?: Pipeline; normalPipeline?: Pipeline; overPipeline?: Pipeline }
  const ready = raw.initialize()
  return { driver, raw, boundary, ready }
}
async function createDriver(options: Parameters<typeof startDriver>[0] = { flag: '1' }) {
  const fixture = startDriver(options)
  await fixture.ready
  expect(fixture.raw.pipelines).toBeInstanceOf(PipelineRegistry)
  return fixture
}
beforeEach(() => {
  vi.stubEnv('VITE_DESIGN_DYNAMIC_UNIFORMS', '0')
  vi.stubEnv('VITE_DESIGN_GPU_TIMINGS', '0')
  vi.stubEnv('VITE_DESIGN_SAMPLE_ONLY_COVERAGE', '0')
  vi.stubEnv('VITE_DESIGN_STATIC_IMAGE_BLUR_CACHE', '0')
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('strict empty managed topology qualification', () => {
  test('accepts only ordinary empty topology with absent, undefined or false sequential display', () => {
    for (const nodes of [{}, Object.create(null)]) for (const policy of [{}, { sequentialDisplay: undefined }, { sequentialDisplay: false }])
      expect(emptyManagedComposeScene(scene({ nodes, ...policy }), true)).toBe(true)
    expect(emptyManagedComposeScene(Object.freeze(scene({ nodes: Object.freeze({}), roots: Object.freeze([]) })), true)).toBe(true)
    for (const managed of [false, undefined, null, 0, 1, 'true'])
      expect(emptyManagedComposeScene(scene(), managed as boolean)).toBe(false)
  })
  test('rejects nonempty, exotic, hidden and symbol-bearing topology', () => {
    const hidden = Object.defineProperty({}, 'hidden', { value: {} })
    const symbol = { [Symbol('node')]: {} }
    for (const nodes of [{ node: {} }, hidden, symbol, [], new Map(), new Date(), Object.create({}), null, () => {}])
      expect(emptyManagedComposeScene(scene({ nodes }), true)).toBe(false)
    const customPrototype: unknown[] = []; Object.setPrototypeOf(customPrototype, Object.create(Array.prototype))
    for (const roots of [['node'], { length: 0 }, Object.assign([], { extra: true }),
      Object.assign([], { [Symbol('root')]: true }), Object.assign([], { [Symbol.iterator]: function* () {} }), customPrototype, null])
      expect(emptyManagedComposeScene(scene({ roots }), true)).toBe(false)
    for (const sequentialDisplay of [true, 1, '1', 'true', {}, [], null, 0, ''])
      expect(emptyManagedComposeScene(scene({ sequentialDisplay }), true)).toBe(false)
  })
  test('never invokes topology/policy getters and rejects inherited fields and reflection failures', () => {
    const get = vi.fn(() => { throw Error('getter must not execute') })
    for (const key of ['nodes', 'roots', 'sequentialDisplay']) {
      const value = scene(); Object.defineProperty(value, key, { get })
      expect(emptyManagedComposeScene(value, true)).toBe(false)
    }
    expect(get).not.toHaveBeenCalled()
    for (const key of ['nodes', 'roots']) {
      const value = scene(), inherited = value[key as 'nodes' | 'roots']
      delete (value as any)[key]; Object.setPrototypeOf(value, { [key]: inherited })
      expect(emptyManagedComposeScene(value, true)).toBe(false)
    }
    for (const sequentialDisplay of [false, undefined, true]) {
      const value = scene(); Object.setPrototypeOf(value, { sequentialDisplay })
      expect(emptyManagedComposeScene(value, true)).toBe(false)
    }
    const revoked = Proxy.revocable({}, {}); revoked.revoke()
    expect(emptyManagedComposeScene(scene({ nodes: revoked.proxy }), true)).toBe(false)
    expect(emptyManagedComposeScene(new Proxy(scene(), { getOwnPropertyDescriptor() { throw Error('reflection failure') } }), true)).toBe(false)
    expect(emptyManagedComposeScene(scene({ nodes: new Proxy({}, { ownKeys() { throw Error('own keys failure') } }) }), true)).toBe(false)
  })
})

describe('production compose admission at a mocked GPU device', () => {
  test.each([undefined, '0', 'true', '01'])('flag %s preserves the old full managed compose group', async flag => {
    const { driver, raw, boundary } = await createDriver({ flag })
    expect(boundary.composeEntries()).toEqual([])
    expect([...raw.pipelines.keys()]).toContain('compose')
    await driver.prepareScene(scene())
    expect(boundary.composeEntries()).toEqual(allCompose)
    expect(raw.overPipeline).toBe(raw.normalPipeline)
    expect(boundary.compose().every(descriptor => descriptor.fragment.constants === undefined)).toBe(true)
  })
  test.each([undefined, '0', '1'])('unmanaged flag %s retains the ordinary blended compose descriptor', async flag => {
    const { driver, boundary } = await createDriver({ managed: false, flag })
    const baseline = boundary.starts.length
    await driver.prepareScene(scene({ floatCompositing: false }))
    expect(boundary.starts.slice(baseline)).toHaveLength(1)
    expect(boundary.starts[baseline].fragment).toMatchObject({ entryPoint: 'fragment', targets: [{
      format: 'rgba8unorm', blend: {
        color: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
        alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      },
    }] })
    expect(boundary.composeEntries()).toEqual([])
  })
  test('flag 1 admits exactly two unchanged copy descriptors for the first empty scene', async () => {
    const { driver, raw, boundary } = await createDriver()
    const initial = boundary.starts.length
    expect(boundary.composeEntries()).toEqual([])
    expect([...raw.pipelines.keys()].some(key => key.startsWith('compose:'))).toBe(false)
    await driver.prepareScene(scene())
    expect(boundary.starts.slice(initial)).toEqual(boundary.compose())
    expect(boundary.composeEntries()).toEqual(copies)
    for (const descriptor of boundary.compose()) {
      expect(descriptor.vertex.entryPoint).toBe('quad')
      expect(descriptor.fragment.targets).toEqual([{ format: 'rgba32float' }])
      expect(descriptor.fragment.constants).toBeUndefined()
      expect(descriptor.primitive).toEqual({ topology: 'triangle-list' })
    }
    expect(raw.copyPipeline).toBeDefined(); expect(raw.copyCornerPipeline).toBeDefined()
    expect(raw.normalPipeline).toBeUndefined(); expect(raw.overPipeline).toBeUndefined()
    // The group itself counts as one registry build but not a native pipeline.
    expect({ builds: raw.pipelines.builds, ready: raw.pipelines.ready, native: boundary.starts.length })
      .toEqual({ builds: 5, ready: 5, native: 4 })
  })
  test.each([true, 1, 'true', {}])('empty sequentialDisplay=%s retains all nine compose descriptors', async sequentialDisplay => {
    const { driver, boundary } = await createDriver()
    await driver.prepareScene(scene({ sequentialDisplay }))
    expect(boundary.composeEntries()).toEqual(allCompose)
  })
  test.each([
    { name: 'plain', overrides: {}, modes: [] },
    { name: 'coherent', overrides: { coherentSamples: true }, modes: [23] },
    { name: 'coherent resolved', overrides: { coherentSamples: true,
      resolve: { width: 8, height: 8, offsetX: 0, offsetY: 0, scale: 2 } }, modes: [24] },
    { name: 'resolved', overrides: {
      resolve: { width: 8, height: 8, offsetX: 0, offsetY: 0, scale: 2 } }, modes: [21] },
    { name: 'presented', overrides: {
      presentation: { width: 8, height: 8, offsetX: 0, offsetY: 0, scale: 2 } }, modes: [18, 33] },
  ])('$name empty scene retains its generic modes independently of copy admission and display intent', async ({ overrides, modes }) => {
    // This is admission only, not successful finish/readback/pixel evidence.
    for (const displayOnly of [false, true]) {
      const { driver, boundary } = await createDriver()
      const initial = boundary.starts.length
      await driver.prepareScene(scene(overrides), displayOnly)
      expect(boundary.composeEntries()).toEqual(copies)
      expect(boundary.starts.slice(initial).filter(descriptor => descriptor.fragment.constants !== undefined)
        .map(descriptor => descriptor.fragment.constants!.COMPOSITOR_MODE)).toEqual(modes)
      expect(boundary.starts).toHaveLength(initial + 2 + modes.length)
    }
  })
  test('fresh full and empty-to-full accounting separates registry dependencies from native pipelines', async () => {
    const fresh = await createDriver()
    await fresh.driver.prepareScene(scene({ sequentialDisplay: true }))
    expect({ builds: fresh.raw.pipelines.builds, ready: fresh.raw.pipelines.ready, native: fresh.boundary.starts.length })
      .toEqual({ builds: 12, ready: 12, native: 11 })
    const warmed = await createDriver()
    await warmed.driver.prepareScene(scene())
    await warmed.driver.prepareScene(scene({ sequentialDisplay: true }))
    expect({ builds: warmed.raw.pipelines.builds, ready: warmed.raw.pipelines.ready, native: warmed.boundary.starts.length })
      .toEqual({ builds: 13, ready: 13, native: 11 })
    const before = warmed.boundary.starts.length
    await warmed.driver.prepareScene(scene())
    expect(warmed.boundary.starts).toHaveLength(before)
    expect(warmed.raw.pipelines.builds).toBe(13)
    expect(warmed.raw.pipelines.ready).toBe(13)
  })
  test('uncertain but enumerable-empty topology conservatively enters full admission', async () => {
    const hiddenNodes = Object.defineProperty({}, 'hidden', { value: {} })
    const inheritedPolicy = scene(); Object.setPrototypeOf(inheritedPolicy, { sequentialDisplay: false })
    const candidates = [scene({ nodes: hiddenNodes }), scene({ nodes: { [Symbol('node')]: {} } }),
      scene({ nodes: Object.create({ inherited: true }) }), scene({ roots: Object.assign([], { extra: true }) }),
      inheritedPolicy]
    for (const candidate of candidates) {
      const { driver, boundary } = await createDriver()
      expect(emptyManagedComposeScene(candidate, true)).toBe(false)
      await driver.prepareScene(candidate)
      expect(boundary.composeEntries()).toEqual(allCompose)
    }
  })
  test('the first nonempty scene starts the original eight in order and starts alpha only after all eight finish', async () => {
    const gates = new Map(peers.map(entry => [entry, deferred()]))
    const { driver, boundary } = await createDriver({ flag: '1', onPipeline: descriptor =>
      isCompose(descriptor) ? gates.get(descriptor.fragment.entryPoint as typeof peers[number])?.promise : undefined })
    const pending = observe(driver.prepareScene(nonemptyScene()))
    expect(boundary.composeEntries()).toEqual(peers)
    for (const entry of peers.slice(0, -1)) gates.get(entry)!.resolve()
    await nextTurn()
    expect(pending.settled()).toBe(false)
    expect(boundary.composeEntries()).toEqual(peers)
    gates.get('exactImageResolveStep')!.resolve()
    expect((await pending.result).ok).toBe(true)
    expect(boundary.composeEntries()).toEqual(allCompose)
    const alphaStart = boundary.events.findIndex(event => event.kind === 'start' && event.entry === 'exactAlphaResolve')
    for (const entry of peers) expect(boundary.events.findIndex(event => event.kind === 'complete' &&
      event.entry === entry && event.format === 'rgba32float')).toBeLessThan(alphaStart)
  })
  test('LAZY_PIPELINES=0 preserves eight-before-alpha ordering without exposing hidden dependencies', async () => {
    const gates = new Map(peers.map(entry => [entry, deferred()]))
    const fixture = startDriver({ flag: '1', eager: true, onPipeline: descriptor =>
      isCompose(descriptor) ? gates.get(descriptor.fragment.entryPoint as typeof peers[number])?.promise : undefined })
    const pending = observe(fixture.ready)
    await nextTurn()
    expect(fixture.boundary.composeEntries()).toEqual(peers)
    expect([...fixture.raw.pipelines.keys()].filter(key => key.startsWith('compose'))).toEqual(['compose'])
    for (const entry of peers.slice(1)) gates.get(entry)!.resolve()
    await nextTurn()
    expect(pending.settled()).toBe(false)
    expect(fixture.boundary.composeEntries()).toEqual(peers)
    gates.get('exactNormal')!.resolve()
    expect((await pending.result).ok).toBe(true)
    expect(fixture.boundary.composeEntries()).toEqual(allCompose)
    const before = fixture.boundary.starts.length
    await fixture.driver.prepareScene(scene())
    expect(fixture.boundary.starts).toHaveLength(before)
  })
  test('empty, nonempty, then empty reuses both copies instead of recompiling them', async () => {
    const { driver, raw, boundary } = await createDriver()
    await driver.prepareScene(scene())
    const firstCopy = raw.copyPipeline, firstCorner = raw.copyCornerPipeline
    await driver.prepareScene(nonemptyScene())
    expect(boundary.composeEntries()).toEqual([...copies, ...peers.filter(entry => !copies.includes(entry)), 'exactAlphaResolve'])
    const before = boundary.starts.length
    await driver.prepareScene(scene())
    expect(boundary.starts).toHaveLength(before)
    expect(raw.copyPipeline).toBe(firstCopy); expect(raw.copyCornerPipeline).toBe(firstCorner)
    for (const entry of allCompose) expect(boundary.composeEntries().filter(value => value === entry)).toHaveLength(1)
  })
  test('overlapping empty and nonempty preparation shares both in-flight copy descriptors', async () => {
    const gates = new Map(copies.map(entry => [entry, deferred()]))
    const { driver, boundary } = await createDriver({ flag: '1', onPipeline: descriptor =>
      isCompose(descriptor) ? gates.get(descriptor.fragment.entryPoint)?.promise : undefined })
    const emptyFirst = observe(driver.prepareScene(scene()))
    const full = observe(driver.prepareScene(nonemptyScene()))
    const emptyAgain = observe(driver.prepareScene(scene()))
    expect(boundary.composeEntries()).toEqual([...copies, ...peers.filter(entry => !copies.includes(entry))])
    gates.get('exactPresent')!.resolve(); await nextTurn()
    expect(emptyFirst.settled()).toBe(false); expect(full.settled()).toBe(false); expect(emptyAgain.settled()).toBe(false)
    gates.get('exactCopyCorner')!.resolve()
    const results = await Promise.all([emptyFirst.result, full.result, emptyAgain.result])
    expect(results.every(result => result.ok)).toBe(true)
    for (const entry of allCompose) expect(boundary.composeEntries().filter(value => value === entry)).toHaveLength(1)
  })
  test('an empty request can finish while an earlier full request still awaits a non-copy descriptor', async () => {
    const normal = deferred()
    const { driver, boundary } = await createDriver({ flag: '1', onPipeline: descriptor =>
      isCompose(descriptor) && descriptor.fragment.entryPoint === 'exactNormal' ? normal.promise : undefined })
    const full = observe(driver.prepareScene(scene({ sequentialDisplay: true })))
    const empty = observe(driver.prepareScene(scene()))
    expect((await empty.result).ok).toBe(true)
    expect(full.settled()).toBe(false)
    expect(boundary.composeEntries()).toEqual(peers)
    normal.resolve()
    expect((await full.result).ok).toBe(true)
    expect(boundary.composeEntries()).toEqual(allCompose)
  })
  test('late completion publishes pipelines without restoring an earlier scene policy', async () => {
    const normal = deferred()
    const { driver } = await createDriver({ flag: '1', onPipeline: descriptor =>
      isCompose(descriptor) && descriptor.fragment.entryPoint === 'exactNormal' ? normal.promise : undefined })
    const raw = driver as any
    const earlier = observe(driver.prepareScene(scene({ sequentialDisplay: true, displayFilters: true,
      interactionRetained: true, nativeInteraction: true, pairedDisplayFilters: true })))
    const latest = scene({ displayFilters: false, interactionRetained: false, nativeInteraction: false,
      pairedDisplayFilters: false, displayFilterRadiusLimit: 7 })
    await driver.prepareScene(latest)
    const policy = () => ({ displayFilters: raw.displayFilters, interactionPresentation: raw.interactionPresentation,
      nativeInteractionPresentation: raw.nativeInteractionPresentation, pairDisplayTaps: raw.pairDisplayTaps,
      displayFilterRadiusLimit: raw.displayFilterRadiusLimit })
    const expected = { displayFilters: false, interactionPresentation: false, nativeInteractionPresentation: false,
      pairDisplayTaps: false, displayFilterRadiusLimit: 7 }
    expect(policy()).toEqual(expected)
    expect(earlier.settled()).toBe(false)
    normal.resolve()
    expect((await earlier.result).ok).toBe(true)
    expect(policy()).toEqual(expected)
  })
  test('a failure in an unused normal descriptor is deferred until full composition is demanded', async () => {
    const error = Error('unused normal descriptor fails')
    const { driver, boundary } = await createDriver({ flag: '1', onPipeline: descriptor => {
      if (isCompose(descriptor) && descriptor.fragment.entryPoint === 'exactNormal') throw error
    } })
    await driver.prepareScene(scene())
    expect(boundary.composeEntries()).toEqual(copies)
    await expect(driver.prepareScene(scene({ sequentialDisplay: true }))).rejects.toBe(error)
    expect(boundary.composeEntries()).toEqual([...copies, ...peers.filter(entry => !copies.includes(entry))])
    const before = boundary.starts.length
    await driver.prepareScene(scene())
    await expect(driver.prepareScene(scene({ sequentialDisplay: true }))).rejects.toBe(error)
    expect(boundary.starts).toHaveLength(before)
  })
  test('empty-copy rejection drains its delayed sibling, picks descriptor-order error and remains sticky', async () => {
    const gates = new Map(copies.map(entry => [entry, deferred()]))
    const firstError = Error('present failed later'), earlyError = Error('corner failed first')
    const { driver, raw, boundary } = await createDriver({ flag: '1', onPipeline: descriptor =>
      isCompose(descriptor) ? gates.get(descriptor.fragment.entryPoint)?.promise : undefined })
    const one = observe(driver.prepareScene(scene())), two = observe(driver.prepareScene(scene()))
    gates.get('exactCopyCorner')!.reject(earlyError); await nextTurn()
    expect(one.settled()).toBe(false); expect(two.settled()).toBe(false)
    expect(raw.copyPipeline).toBeUndefined(); expect(raw.copyCornerPipeline).toBeUndefined()
    gates.get('exactPresent')!.reject(firstError)
    expect(await one.result).toEqual({ ok: false, error: firstError })
    expect(await two.result).toEqual({ ok: false, error: firstError })
    await expect(driver.prepareScene(scene())).rejects.toBe(firstError)
    expect(boundary.composeEntries()).toEqual(copies)
    // Full admission can start only the six missing peers, not retry copies.
    await expect(driver.prepareScene(nonemptyScene())).rejects.toBe(firstError)
    expect(boundary.composeEntries()).toEqual([...copies, ...peers.filter(entry => !copies.includes(entry))])
    expect(boundary.composeEntries()).not.toContain('exactAlphaResolve')
  })
  test('full rejection drains all eight siblings, never starts alpha and selects ordered first error', async () => {
    const gates = new Map(peers.map(entry => [entry, deferred()]))
    const orderedError = Error('normal failed later'), earlyError = Error('shadow failed first')
    const { driver, raw, boundary } = await createDriver({ flag: '1', onPipeline: descriptor =>
      isCompose(descriptor) ? gates.get(descriptor.fragment.entryPoint as typeof peers[number])?.promise : undefined })
    const pending = observe(driver.prepareScene(nonemptyScene()))
    gates.get('exactShadowOver')!.reject(earlyError)
    for (const entry of peers) if (!['exactNormal', 'exactShadowOver', 'exactImageResolveStep'].includes(entry)) gates.get(entry)!.resolve()
    gates.get('exactNormal')!.reject(orderedError); await nextTurn()
    expect(pending.settled()).toBe(false)
    expect(raw.normalPipeline).toBeUndefined(); expect(raw.overPipeline).toBeUndefined()
    gates.get('exactImageResolveStep')!.resolve()
    expect(await pending.result).toEqual({ ok: false, error: orderedError })
    await expect(driver.prepareScene(nonemptyScene())).rejects.toBe(orderedError)
    expect(boundary.composeEntries()).toEqual(peers)
  })
  test('an empty-copy rejection drains only its dependency closure, not another concurrent full preparation', async () => {
    const gates = new Map(peers.map(entry => [entry, deferred()]))
    const error = Error('shared present failure')
    const { driver, boundary } = await createDriver({ flag: '1', onPipeline: descriptor =>
      isCompose(descriptor) ? gates.get(descriptor.fragment.entryPoint as typeof peers[number])?.promise : undefined })
    const full = observe(driver.prepareScene(scene({ sequentialDisplay: true })))
    const empty = observe(driver.prepareScene(scene()))
    gates.get('exactPresent')!.reject(error); await nextTurn()
    expect(empty.settled()).toBe(false)
    gates.get('exactCopyCorner')!.resolve()
    expect(await empty.result).toEqual({ ok: false, error })
    expect(full.settled()).toBe(false)
    expect(boundary.composeEntries()).toEqual(peers)
    // A caller cannot infer device-wide idle or clean up from empty's error.
    // It must still await every other preparation it started on this device.
    for (const entry of peers) if (!copies.includes(entry)) gates.get(entry)!.resolve()
    expect(await full.result).toEqual({ ok: false, error })
    expect(boundary.composeEntries()).not.toContain('exactAlphaResolve')
  })
  test('a replacement driver/device has an independent registry after a sticky failure', async () => {
    const error = Error('first device copy failure')
    const first = await createDriver({ flag: '1', onPipeline: descriptor => {
      if (isCompose(descriptor) && descriptor.fragment.entryPoint === 'exactPresent') throw error
    } })
    await expect(first.driver.prepareScene(scene())).rejects.toBe(error)
    await expect(first.driver.prepareScene(scene())).rejects.toBe(error)
    const replacement = await createDriver()
    expect(replacement.boundary.device).not.toBe(first.boundary.device)
    expect(replacement.raw.pipelines).not.toBe(first.raw.pipelines)
    await replacement.driver.prepareScene(scene())
    expect(first.boundary.composeEntries()).toEqual(copies)
    expect(replacement.boundary.composeEntries()).toEqual(copies)
    expect(replacement.raw.copyPipeline).toBeDefined()
  })
  test('actual synchronous mode 0 uses integer and fractional copies; unprepared mode 3 throws before drawing', async () => {
    const { driver, raw, boundary } = await createDriver()
    const empty = scene(); await driver.prepareScene(empty)
    driver.begin(new Float32Array(0))
    const target = driver.create(8, 8), source = driver.create(8, 8)
    const integer = parameters(empty.extent); integer[16] = 0
    expect(driver.pass(target, integer, [source])).toBeUndefined()
    const fractional = parameters(empty.extent, { ...empty.extent, x: 0.25 }); fractional[16] = 0
    expect(driver.pass(target, fractional, [source])).toBeUndefined()
    const outsideExactBound = parameters(empty.extent, { ...empty.extent, x: 1048577 }); outsideExactBound[16] = 0
    expect(driver.pass(target, outsideExactBound, [source])).toBeUndefined()
    const displayTransform = parameters(empty.extent); displayTransform[16] = 0; displayTransform[242] = 1
    expect(driver.pass(target, displayTransform, [source])).toBeUndefined()
    expect(boundary.draws).toEqual([raw.copyCornerPipeline, raw.copyPipeline, raw.copyPipeline, raw.copyPipeline])
    expect(boundary.draws.map(pipeline => pipeline.fragment.entryPoint))
      .toEqual(['exactCopyCorner', 'exactPresent', 'exactPresent', 'exactPresent'])
    const calls = boundary.starts.length, passes = boundary.renderPasses.length
    for (const x of [0, 0.25]) {
      const normal = parameters(empty.extent, { ...empty.extent, x }); normal[16] = 3; normal[17] = 0
      expect(() => driver.pass(target, normal, [source])).toThrow('Exact compositor pipeline 3 not prepared')
    }
    expect(boundary.starts).toHaveLength(calls)
    expect(boundary.renderPasses).toHaveLength(passes)
    expect(boundary.draws).toHaveLength(4)
  })
  test('real renderer cancellation during real prepareScene never begins or finishes a frame', async () => {
    const gate = deferred()
    const { driver, boundary } = await createDriver({ flag: '1', onPipeline: descriptor =>
      isCompose(descriptor) && descriptor.fragment.entryPoint === 'exactCopyCorner' ? gate.promise : undefined })
    const renderer = new GpuRenderer(driver)
    // These are call-through spies, not stubbed successful render methods.
    const prepare = vi.spyOn(driver, 'prepareScene'), begin = vi.spyOn(driver, 'begin')
    const finish = vi.spyOn(driver, 'finish'), abort = vi.spyOn(driver, 'abortFrameAndReleaseFilterScratch')
    const frameResources = vi.spyOn(driver, 'prepareFrameResources')
    let current = true
    const empty = scene(), pending = observe(renderer.render(empty, false, true, () => current))
    expect(prepare).toHaveBeenCalledWith(empty, true)
    expect(boundary.composeEntries()).toEqual(copies)
    current = false; await nextTurn()
    expect(pending.settled()).toBe(false)
    gate.resolve()
    const result = await pending.result
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatchObject({ message: 'PREVIEW_CANCELLED' })
    expect(begin).not.toHaveBeenCalled(); expect(finish).not.toHaveBeenCalled()
    expect(frameResources).not.toHaveBeenCalled(); expect(abort).not.toHaveBeenCalled()
    expect(boundary.draws).toHaveLength(0)
    // Only device initialization submitted its blank-texture clear.
    expect(boundary.device.queue.submit).toHaveBeenCalledTimes(1)
  })
})
