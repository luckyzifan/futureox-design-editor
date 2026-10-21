import { afterEach, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { color_encode_png, encode_png_rgba, VectorEngine } from '../generated/design-kernel/design_kernel'
import { blank, node, paint } from '../model'
import { documentPatch } from '../document-patch'
import { createRenderPolicy } from './render-policy'

const state = vi.hoisted(() => ({
  failAttach: false, failBudgetOnce: false, renders: [] as { readback: boolean; present: boolean; scene: any }[], transfers: [] as any[],
  keys: [] as { uri: string; variant: string; settings: string }[], reads: [] as string[],
  scenes: [] as any[], loads: [] as { uri: string; render: number; bytes?: Uint8Array; pixels: Float32Array }[],
  readGate: undefined as undefined | Promise<unknown>, keyGate: undefined as undefined | Promise<void>,
  font: undefined as Uint8Array | undefined,
  disposed: [] as number[], createCount: 0, onPost: undefined as undefined | ((value: any) => void),
}))
vi.mock('./image-mip-cache', () => ({
  imageCacheKey: async (uri: string, variant: string, settings: string) => {
    state.keys.push({ uri, variant, settings }); await state.keyGate
    return `${variant}:${uri}`
  },
  readCachedImage: async (key: string) => { state.reads.push(key); return state.readGate ? await state.readGate : undefined },
  writeCachedImage() {},
}))
vi.mock('./kernel-resources', () => ({ loadKernelResources: async () => state.font }))
vi.mock('./gpu/factory', async () => {
  const { sceneIndex } = await import('./gpu/scene-index')
  const { GpuRenderer } = await import('./gpu/renderer')
  return {
    straightAlpha: (bytes: Uint8Array) => bytes,
    createGpu: async (backend: string, _optimized: boolean, _batch: boolean, _color: unknown, loader: any,
      _hdr: boolean, floating: boolean, _mips: boolean, _atlas: boolean, displayMath: boolean) => {
      const identity = ++state.createCount
      const upload = (data: Uint8Array | Float32Array, width: number, height: number) => ({ width, height,
        bytes: data.byteLength, resource: { image: data.slice() } })
      const resources = new GpuRenderer({ scratchBytes: 0, uploadRgba8: upload, uploadLinear: upload,
        destroy() {}, dispose() {} } as any, true, true, loader) as any
      return { driver: { name: backend, managed: floating, displayMath, lost: false, description: 'CPU test driver', attachPresenter: vi.fn(() => { if (state.failAttach) throw Error('Presenter attachment failed') }), abortFrameAndReleaseFilterScratch: async () => {} },
        dispose() { expect(state.disposed).not.toContain(identity); state.disposed.push(identity); resources.dispose() },
        abortFrameAndReleaseFilterScratch: async () => {},
        releaseFilterBatch() {},
        async render(scene: any, readback = false, present = true) {
          state.renders.push({ readback, present, scene })
          if (state.failBudgetOnce) { state.failBudgetOnce = false; throw Error('GPU surface budget exceeded') }
          state.scenes.push(scene); resources.scene = scene
          await resources.loadImages(scene)
          for (const uri of sceneIndex(scene).images) {
            const image = resources.imageFor(uri, 0, false).texture.resource.image
            state.loads.push({ uri, render: state.scenes.length,
              pixels: image instanceof Float32Array ? image : new Float32Array(),
              bytes: image instanceof Uint8Array ? image : undefined })
          }
          // Mock transport only. Pixel/texture equivalence is separately tested
          // with the real WASM and production GpuRenderer upload path.
          if (!readback && present && (globalThis as any).__mockBitmapPreview)
            return { bitmap: { width: scene.width, height: scene.height, close: vi.fn() }, drawCalls: 0, triangles: 0 }
          return { rgba: new Uint8Array((scene.presentation?.width ?? scene.resolve?.width ?? scene.width) *
            (scene.presentation?.height ?? scene.resolve?.height ?? scene.height) * 4), drawCalls: 0, triangles: 0 }
        },
      }
    },
  }
})
const channels: MessageChannel[] = []
const NativeMessageChannel = MessageChannel
const wasm = new Uint8Array(readFileSync(new URL('../../public/kernel/design_kernel_bg.wasm', import.meta.url)))
afterEach(() => { channels.splice(0).forEach(pair => { pair.port1.close(); pair.port2.close() }); vi.unstubAllGlobals() })
function fixture(count = 1000) {
  const doc = blank('Worker hydration fixture'); doc.id = 'worker-image-document'; doc.pages[0].id = 'visible'
  doc.pages.push({ ...doc.pages[0], id: 'other', name: 'Other page', children: [] })
  const images: string[] = []
  for (let i = 0; i < count; i++) {
    const image = `data:image/png;base64,${Buffer.from(encode_png_rgba(1, 1,
      new Uint8Array([i % 256, Math.floor(i / 256), (i * 31) % 256, 255]))).toString('base64')}`
    const n = node('rectangle', i % 4 * 12, 0, 12, 12); n.id = `image-${i}`
    n.fills = [{ ...paint('#ffffff'), id: `paint-${i}`, kind: 'image', image }]
    doc.nodes[n.id] = n; doc.pages[i < 4 ? 0 : 1].children.push(n.id); images.push(image)
  }
  const options = { pageId: 'visible', width: 48, height: 16, view: { x: 0, y: 0, zoom: 1 }, rasterProfile: 'analytic', renderIntent: 'canvas' }
  return { doc, images, options }
}
async function worker(desktopFullMath = false, withPreparation = false) {
  vi.resetModules()
  Object.assign(state, { failAttach: false, failBudgetOnce: false, renders: [], transfers: [], keys: [], reads: [], scenes: [], loads: [], keyGate: undefined, readGate: undefined, disposed: [], createCount: 0, onPost: undefined })
  state.font = withPreparation ? new Uint8Array(readFileSync(new URL('../../public/fonts/NotoSansSC.ttf', import.meta.url))) : undefined
  const kernel = await import('../generated/design-kernel/design_kernel')
  await kernel.default({ module_or_path: wasm })
  let preparationPort: MessagePort | undefined
  if (withPreparation) {
    const preparationScope: any = {}
    vi.stubGlobal('self', preparationScope)
    await import('./preparation-worker')
    const pair = new NativeMessageChannel(); channels.push(pair)
    preparationScope.onmessage({ data: { port: pair.port2 } }); preparationPort = pair.port1
  }
  const messages: any[] = [], scope: any = { postMessage(value: unknown, transfer: unknown) { messages.push(value); state.transfers.push(transfer); state.onPost?.(value) } }
  vi.stubGlobal('self', scope)
  vi.stubGlobal('MessageChannel', class {
    constructor() { const channel = new NativeMessageChannel(); channels.push(channel); return channel }
  })
  await import('./render-worker')
  if (preparationPort) scope.onmessage({ data: { command: 'prepare-port', port: preparationPort } })
  const executionPolicy = createRenderPolicy(false, false, false, false, desktopFullMath)
  const send = (request: any) => scope.onmessage({ data: { executionPolicy, backend: 'auto', ...request } })
  const finish = async (id: number) => {
    await vi.waitFor(() => expect(messages.some(value => value.id === id && (value.backend || value.error))).toBe(true))
    return messages.find(value => value.id === id && (value.backend || value.error))
  }
  return { send, finish, messages, kernel }
}

for (const managed of [false, true]) test(`same exact canvas snapshot reuses decoded assets across interaction and pose patches (managed=${managed})`, async () => {
  const f = fixture(4), w = await worker(true)
  if (managed) {
    f.doc.schemaVersion = 3; f.doc.rasterProfile = 'figma'; f.options.rasterProfile = 'figmaSubpixel'
    f.doc.colorManagement = { documentSpace: 'srgb', referenceWhiteNits: 203, peakLuminanceNits: 1000 }
  }
  const info = vi.spyOn(w.kernel.VectorEngine.prototype, 'image_info')
  try {
    const source = JSON.stringify(f.doc)
    w.send({ id: 901, backend: 'webgpu', document: source, documentRevision: 1, options: f.options, readback: true })
    expect((await w.finish(901)).error).toBeUndefined()
    expect(info).toHaveBeenCalledTimes(4); expect(state.reads).toHaveLength(4)
    const initial = state.loads.map(value => new Uint8Array((value.bytes ?? value.pixels).buffer).slice())
    // Force a fresh upload path as well as lane hydration; a retained GPU image
    // alone must not conceal a second synchronous WASM decode.
    w.send({ id: 902, backend: 'webgl2', channel: 'interaction', document: source, documentRevision: 1, options: f.options, readback: true })
    expect((await w.finish(902)).error).toBeUndefined()
    expect(info).toHaveBeenCalledTimes(4); expect(state.reads).toHaveLength(4)
    expect(state.createCount).toBe(2)
    expect(state.loads.slice(4).map(value => new Uint8Array((value.bytes ?? value.pixels).buffer))).toEqual(initial)
    const moved = structuredClone(f.doc); moved.nodes['image-0'].transform[4] += 1
    w.send({ id: 903, backend: 'webgpu', channel: 'interaction', documentPatch: JSON.stringify(documentPatch(f.doc, moved)),
      baseDocumentRevision: 1, documentRevision: 2, options: f.options, readback: true })
    expect((await w.finish(903)).error).toBeUndefined()
    expect(info).toHaveBeenCalledTimes(4); expect(state.reads).toHaveLength(4)
    w.send({ id: 904, backend: 'webgl2', documentRevision: 1, options: f.options, readback: true })
    expect((await w.finish(904)).error).toBeUndefined()
    expect(info).toHaveBeenCalledTimes(4); expect(state.reads).toHaveLength(4)
    expect(state.loads.slice(-4).map(value => new Uint8Array((value.bytes ?? value.pixels).buffer))).toEqual(initial)
    // A full reopen gets a new owner even if the entire JSON and document ID
    // repeat. It must not inherit the retired session's in-memory residency.
    w.send({ id: 905, backend: 'webgpu', document: source, documentRevision: 2, options: f.options, readback: true })
    expect((await w.finish(905)).error).toBeUndefined()
    expect(info).toHaveBeenCalledTimes(8); expect(state.reads).toHaveLength(8)
  } finally { info.mockRestore() }
})

test('same-ID interaction with different complete authored bytes cannot borrow the canvas image owner', async () => {
  const f = fixture(4), w = await worker()
  w.send({ id: 911, document: JSON.stringify(f.doc), documentRevision: 1, options: f.options, readback: true })
  expect((await w.finish(911)).error).toBeUndefined(); expect(state.reads).toHaveLength(4)
  const other = structuredClone(f.doc); other.name = 'A different same-ID authored snapshot'
  w.send({ id: 912, channel: 'interaction', document: JSON.stringify(other), documentRevision: 1, options: f.options, readback: true })
  expect((await w.finish(912)).error).toBeUndefined(); expect(state.reads).toHaveLength(8)
  other.id = 'different-document'
  w.send({ id: 913, channel: 'interaction', document: JSON.stringify(other), documentRevision: 2, options: f.options, readback: true })
  expect((await w.finish(913)).error).toBeUndefined(); expect(state.reads).toHaveLength(12)
})

test('acknowledged native derivation shares exact image pixels without exporting or decoding them again', async () => {
  const f = fixture(4), w = await worker(true, true)
  f.doc.schemaVersion = 3; f.doc.rasterProfile = 'figma'; f.options.rasterProfile = 'figmaSubpixel'
  f.doc.colorManagement = { documentSpace: 'srgb', referenceWhiteNits: 203, peakLuminanceNits: 1000 }
  const info = vi.spyOn(w.kernel.VectorEngine.prototype, 'image_info')
  try {
    w.send({ id: 921, backend: 'webgpu', document: JSON.stringify(f.doc), documentRevision: 1, options: f.options, readback: true })
    expect((await w.finish(921)).error).toBeUndefined()
    const receipt = w.messages.find(value => value.id === 921 && value.documentSynchronized)?.stateReceipt
    expect(receipt?.lane).toBe('canvas'); expect(info).toHaveBeenCalledTimes(4)
    const initial = state.loads.map(value => new Uint32Array(value.pixels.buffer).slice())
    w.send({ id: 922, backend: 'webgl2', channel: 'interaction', deriveFrom: receipt, documentRevision: 1, options: f.options, readback: true })
    expect((await w.finish(922)).error).toBeUndefined()
    expect(w.messages.some(value => value.id === 922 && value.documentFallback)).toBe(false)
    expect(state.createCount).toBe(2); expect(state.reads).toHaveLength(4); expect(info).toHaveBeenCalledTimes(4)
    expect(state.loads.slice(4).map(value => new Uint32Array(value.pixels.buffer))).toEqual(initial)
  } finally { info.mockRestore() }
})

for (const desktopFullMath of [false, true]) test(`default ${desktopFullMath ? 'Electron' : 'Web'} auto route reads only four compiled sources, preserving decoded payloads`, async () => {
  const f = fixture(), w = await worker(desktopFullMath)
  w.send({ id: 1, document: JSON.stringify(f.doc), documentRevision: 1, options: f.options })
  expect((await w.finish(1)).backend).toBe('webgpu')
  expect(state.reads).toHaveLength(4)
  expect(new Set(state.reads.map(key => key.slice(key.indexOf(':') + 1)))).toEqual(new Set(f.images.slice(0, 4)))
  const reference = new VectorEngine()
  try {
    reference.load_document(JSON.stringify(f.doc))
    for (const image of state.loads) expect(image.bytes ?? image.pixels).toEqual(image.bytes ? reference.image_rgba8(image.uri) : reference.image_linear(image.uri))
  } finally { reference.free() }
})

for (const png of [false, true]) test(`${png ? 'PNG' : 'CPU'} route has zero JS image-cache work and returns exact WASM pixels`, async () => {
  const f = fixture(12), w = await worker()
  w.send({ id: 1, document: JSON.stringify(f.doc), documentRevision: 1, options: f.options, backend: 'cpu', png })
  const result = await w.finish(1)
  expect(result.backend).toBe('cpu'); expect(state.keys).toHaveLength(0); expect(state.reads).toHaveLength(0)
  const reference = new VectorEngine()
  try {
    reference.load_document(JSON.stringify(f.doc))
    const options = JSON.stringify({ ...f.options, interactiveEffects: false, ...(png ? { checkerboard: false } : {}) })
    expect(new Uint8Array(result.buffer)).toEqual(png ? reference.render_png(options) : reference.render_rgba(options))
  } finally { reference.free() }
})

test('immediately canceled full sync still admits its next ordered patch before any hydration', async () => {
  const f = fixture(12), w = await worker()
  const next = structuredClone(f.doc); next.nodes['image-0'].transform[4] = 4
  const options = { ...f.options, renderIntent: 'preview', livePreview: true }
  w.send({ id: 1, document: JSON.stringify(f.doc), documentRevision: 1, options })
  w.send({ command: 'cancel-preview', channel: 'canvas' })
  w.send({ id: 2, documentPatch: JSON.stringify(documentPatch(f.doc, next)), baseDocumentRevision: 1, documentRevision: 2, options })
  expect((await w.finish(1)).error).toContain('PREVIEW_CANCELLED')
  expect((await w.finish(2)).backend).toBe('webgpu')
  expect(state.reads).toHaveLength(4)
  expect(state.scenes).toHaveLength(1)
  expect(state.scenes[0].nodes['image-0'].matrix[4]).toBe(4)
})

test('canceling a pending store read stops later reads and decoding; same-id reopen uses its own source', async () => {
  const f = fixture(12), w = await worker()
  let release!: (record: unknown) => void
  state.readGate = new Promise(resolve => { release = resolve })
  const options = { ...f.options, renderIntent: 'preview', livePreview: true }
  w.send({ id: 1, document: JSON.stringify(f.doc), documentRevision: 1, options })
  await vi.waitFor(() => expect(state.reads).toHaveLength(1))
  w.send({ command: 'cancel-preview' })
  const next = structuredClone(f.doc); next.nodes['image-0'].fills[0].image = f.images[8]
  w.send({ id: 2, document: JSON.stringify(next), documentRevision: 2, options })
  state.readGate = undefined
  release({ width: 1, height: 1, data: new Uint8Array([255, 0, 255, 255]) })
  expect((await w.finish(1)).error).toContain('PREVIEW_CANCELLED')
  expect((await w.finish(2)).backend).toBe('webgpu')
  expect(state.reads).toHaveLength(5); expect(state.scenes).toHaveLength(1)
  expect(state.loads.some(value => value.uri === f.images[0])).toBe(false)
  const expected = new VectorEngine()
  try {
    expected.load_document(JSON.stringify(next))
    for (const image of state.loads) expect(image.bytes ?? image.pixels).toEqual(image.bytes ? expected.image_rgba8(image.uri) : expected.image_linear(image.uri))
  } finally { expected.free() }
})

test('multiple exact tiles hydrate each newly compiled dependency once in the actual worker route', async () => {
  const f = fixture(12), w = await worker()
  const tileViewport = [0, 24].map((x, i) => ({ key: `tile-${i}`, x, y: 0, width: 24, height: 16, zoom: 1 }))
  w.send({ id: 1, document: JSON.stringify(f.doc), documentRevision: 1,
    options: { ...f.options, tileViewport }, readback: true })
  const result = await w.finish(1)
  expect(result.backend).toBe('webgpu')
  expect(state.reads).toHaveLength(4)
  expect(state.scenes).toHaveLength(2)
  expect(w.messages.filter(value => value.id === 1 && value.tile)).toHaveLength(2)
})

for (const reverse of [false, true]) test(`resumed canvas tiles invalidate real image textures after repeated color-lane switches (reverse=${reverse})`, async () => {
  const f = fixture(12), w = await worker(true)
  f.doc.schemaVersion = 3; f.doc.rasterProfile = 'figma'; f.options.rasterProfile = 'figmaSubpixel'
  f.doc.schemaVersion = 3; f.doc.rasterProfile = 'figma'
  f.doc.colorManagement = { documentSpace: 'srgb', referenceWhiteNits: reverse ? 203 : 100, peakLuminanceNits: 1000 }
  const pq = color_encode_png(1, 1, new Float32Array([0.5, 0.25, 0.125, 1]),
    JSON.stringify({ documentSpace: 'srgb', referenceWhiteNits: 203, peakLuminanceNits: 1000 }),
    JSON.stringify({ space: 'rec2100-pq', toneMap: 'none' }))
  const image = `data:image/png;base64,${Buffer.from(pq).toString('base64')}`
  for (let i = 0; i < 4; i++) f.doc.nodes[`image-${i}`].fills[0].image = image
  const interaction = structuredClone(f.doc); interaction.colorManagement!.referenceWhiteNits = reverse ? 100 : 203
  const tileViewport = [0, 12, 24, 36].map((x, i) => ({ key: `color-tile-${i}`, x, y: 0, width: 12, height: 16, zoom: 1 }))
  let interruptions = 0
  state.onPost = value => {
    if (value.id === 1 && value.tile && interruptions < 3) {
      interruptions++
      w.send({ id: interruptions + 1, channel: 'interaction', document: JSON.stringify(interaction), documentRevision: interruptions,
        options: f.options, readback: true })
    }
  }
  w.send({ id: 1, document: JSON.stringify(f.doc), documentRevision: 1,
    options: { ...f.options, tileViewport }, readback: true })
  for (const id of [1, 2, 3, 4]) {
    const result = await w.finish(id); expect(result.error).toBeUndefined(); expect(result.backend).toBe('webgpu')
  }
  expect(interruptions).toBe(3); expect(state.scenes).toHaveLength(7)
  const a = new VectorEngine(), b = new VectorEngine()
  try {
    a.load_document(JSON.stringify(f.doc)); b.load_document(JSON.stringify(interaction))
    const expectedA = a.image_linear(image), expectedB = b.image_linear(image)
    expect(expectedA).not.toEqual(expectedB)
    const samples = state.loads.filter(value => value.uri === image)
    expect(samples.map(value => value.render)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(samples.map(value => value.pixels)).toEqual([expectedA, expectedB, expectedA, expectedB, expectedA, expectedB, expectedA])
    expect(state.createCount).toBe(7); expect(state.disposed).toEqual([1, 2, 3, 4, 5, 6])
  } finally { a.free(); b.free() }
})

for (const command of ['cancel-preview', 'cancel-tile-fill']) test(`${command} during lane yield does not recreate stale canvas resources or dispose the current lane`, async () => {
  const f = fixture(12), w = await worker(true), interaction = structuredClone(f.doc)
  interaction.schemaVersion = 3; interaction.rasterProfile = 'figma'
  interaction.colorManagement = { documentSpace: 'display-p3', referenceWhiteNits: 203, peakLuminanceNits: 1000 }
  const tileViewport = [0, 24].map((x, i) => ({ key: `cancel-tile-${i}`, x, y: 0, width: 24, height: 16, zoom: 1 }))
  let interrupted = false
  state.onPost = value => {
    if (value.id === 1 && value.tile && !interrupted) {
      interrupted = true
      w.send({ id: 2, channel: 'interaction', document: JSON.stringify(interaction), documentRevision: 1,
        options: { ...f.options, rasterProfile: 'figmaSubpixel' }, readback: true })
    }
    if (value.id === 2 && value.backend) w.send({ command, channel: 'canvas' })
  }
  w.send({ id: 1, document: JSON.stringify(f.doc), documentRevision: 1,
    options: { ...f.options, tileViewport }, readback: true })
  expect((await w.finish(1)).error).toContain('PREVIEW_CANCELLED')
  expect((await w.finish(2)).backend).toBe('webgpu')
  expect(state.scenes).toHaveLength(2); expect(state.createCount).toBe(2); expect(state.disposed).toEqual([1])
  expect(w.messages.filter(value => value.id === 1 && value.tile)).toHaveLength(1)
  // The canceled canvas still owns its accepted document revision. Resuming
  // that lane must accept the next patch even though we left the GPU with B.
  const next = structuredClone(f.doc); next.nodes['image-0'].transform[4] += 2
  w.send({ id: 3, backend: 'cpu', documentPatch: JSON.stringify(documentPatch(f.doc, next)),
    baseDocumentRevision: 1, documentRevision: 2, options: f.options })
  const patched = await w.finish(3); expect(patched.error).toBeUndefined(); expect(patched.backend).toBe('cpu')
  const reference = new VectorEngine()
  try {
    reference.load_document(JSON.stringify(next))
    expect(new Uint8Array(patched.buffer)).toEqual(reference.render_rgba(JSON.stringify({ ...f.options, interactiveEffects: false })))
  } finally { reference.free() }
})

for (const desktopFullMath of [false, true]) test(`regional preview recovery preserves ${desktopFullMath ? 'desktop exact' : 'web display'} math and uses bitmap transport`, async () => {
  const f = fixture(4), w = await worker(desktopFullMath)
  f.doc.schemaVersion = 3; f.doc.rasterProfile = 'figma'
  f.doc.colorManagement = { documentSpace: 'srgb', referenceWhiteNits: 203, peakLuminanceNits: 1000 }
  vi.stubGlobal('__mockBitmapPreview', true)
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(public width: number, public height: number) {}
    getContext() { return { drawImage: vi.fn(), imageSmoothingEnabled: false } }
    transferToImageBitmap() { return { width: this.width, height: this.height, close: vi.fn() } }
  })
  w.send({ command: 'display-attach', canvas: {} })
  state.failBudgetOnce = true
  const options = { ...f.options, rasterProfile: 'figmaSubpixel', livePreview: true, previewTileFallback: true, renderIntent: 'preview' }
  w.send({ id: 101, document: JSON.stringify(f.doc), documentRevision: 1, options })
  const result = await w.finish(101)
  expect(result.error).toBeUndefined()
  expect(result.bitmap).toBeDefined()
  expect(result.previewLane).toBe('regional-fallback')
  expect(result.residentAttached).toBe(true)
  expect(result.previewReadback).toBe(false)
  expect(state.createCount).toBe(1)
  expect(state.disposed).toEqual([])
  expect(state.renders.length).toBeGreaterThan(1)
  expect(state.renders.every(({ scene }) => scene.displayFilters === !desktopFullMath)).toBe(true)
  expect(state.renders.slice(1).every(r => !r.readback && r.present)).toBe(true)
  expect(state.transfers.some(t => t?.transfer?.includes(result.bitmap))).toBe(true)
  const count = state.renders.length
  w.send({ id: 102, documentRevision: 1, options })
  const next = await w.finish(102)
  expect(next.bitmap).toBeDefined()
  expect(state.renders.slice(count).every(r => !r.readback && r.present && r.scene.displayFilters === !desktopFullMath)).toBe(true)
  expect(state.createCount).toBe(1)
})

for (const mode of ['readback', 'webgl2', 'transparent'] as const) test(`regional ${mode} preview keeps byte transport`, async () => {
  const f = fixture(4), w = await worker()
  state.failBudgetOnce = true
  w.send({ id: 201, document: JSON.stringify(f.doc), documentRevision: 1,
    backend: mode === 'webgl2' ? 'webgl2' : 'webgpu', readback: mode === 'readback',
    options: { ...f.options, transparent: mode === 'transparent', livePreview: true, previewTileFallback: true, renderIntent: 'preview' } })
  const result = await w.finish(201)
  expect(result.error).toBeUndefined()
  expect(result.bitmap).toBeUndefined()
  expect(result.buffer.byteLength).toBe(f.options.width * f.options.height * 4)
  expect(result.previewReadback).toBe(true)
  expect(state.renders.slice(1).every(r => r.readback && !r.present)).toBe(true)
})

test('display-import closes its bitmap if presenter preparation rejects before handoff', async () => {
  const f = fixture(4), w = await worker()
  w.send({ id: 301, document: JSON.stringify(f.doc), documentRevision: 1, options: f.options })
  await w.finish(301)
  state.failAttach = true
  w.send({ command: 'display-attach', canvas: {} })
  const bitmap = { close: vi.fn() }
  w.send({ id: 302, command: 'display-import', bitmap })
  expect((await w.finish(302)).error).toContain('Presenter attachment failed')
  expect(bitmap.close).toHaveBeenCalledTimes(1)
})

test('real render worker retires obsolete packet waits before their reply without flooding preparation or cancelling exact readback', async () => {
  const f = fixture(4), w = await worker(), pair = new NativeMessageChannel()
  channels.push(pair)
  const prepared = new VectorEngine(), methods: string[] = []
  let release!: () => void, held = false
  pair.port2.onmessage = event => {
    const { id, method, args } = event.data
    methods.push(method)
    const reply = () => {
      if (method === 'preparation_capabilities_v1') { pair.port2.postMessage({ id, error: 'Unknown legacy preparation method' }); return }
      let value: unknown
      if (method !== 'initialize' && method !== 'warm_resources') value = (prepared as any)[method](...args)
      pair.port2.postMessage({ id, value, ...(method === 'load_document' || method === 'initialize' || method === 'apply_document_patch_with_damage' ? { settings: prepared.color_settings() } : {}) })
    }
    if (method === 'compile_gpu_packet' && !held) { held = true; release = reply }
    else reply()
  }
  w.send({ command: 'prepare-port', port: pair.port1 })
  const preview = { ...f.options, renderIntent: 'preview', livePreview: true }
  try {
    w.send({ id: 701, document: JSON.stringify(f.doc), documentRevision: 1, options: preview })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    w.send({ command: 'cancel-preview' })
    expect((await w.finish(701)).error).toContain('PREVIEW_CANCELLED')
    expect(state.renders).toHaveLength(0)
    // This compile must remain locally cancellable while the first physical
    // call is still executing. No transport-level native/WASM preemption.
    w.send({ id: 702, documentRevision: 1, options: { ...preview, width: 49 } })
    await new Promise(resolve => setTimeout(resolve, 10))
    w.send({ command: 'cancel-preview' })
    expect((await w.finish(702)).error).toContain('PREVIEW_CANCELLED')
    expect(methods.filter(x => x === 'compile_gpu_packet')).toHaveLength(1)
    // Settled exact/readback work is never registered with cancellation.
    w.send({ id: 703, documentRevision: 1, options: { ...f.options, width: 50 }, readback: true })
    await new Promise(resolve => setTimeout(resolve, 10))
    w.send({ command: 'cancel-preview' })
    release()
    expect((await w.finish(703)).backend).toBe('webgpu')
    w.send({ id: 704, documentRevision: 1, options: f.options, readback: true })
    expect((await w.finish(704)).backend).toBe('webgpu')
    expect(state.renders).toHaveLength(2)
    expect(methods.filter(x => x === 'compile_gpu_packet')).toHaveLength(3)
  } finally { prepared.free() }
})

test('request-scoped cancellation applies its ordered patch but leaves independent preview and exact work alive', async () => {
  const f = fixture(4), w = await worker()
  w.send({ id: 800, document: JSON.stringify(f.doc), documentRevision: 1, options: f.options })
  expect((await w.finish(800)).backend).toBe('webgpu')
  const preview = { ...f.options, livePreview: true, renderIntent: 'preview' }
  w.send({ id: 801, documentPatch: JSON.stringify({ fields: { name: 'renamed' }, nodes: {} }), baseDocumentRevision: 1, documentRevision: 2, options: preview })
  w.send({ command: 'cancel-request', requestId: 801 })
  w.send({ command: 'cancel-request', requestId: 801 })
  w.send({ id: 802, documentRevision: 2, options: preview })
  w.send({ id: 803, documentRevision: 2, options: f.options, readback: true })
  expect((await w.finish(801)).error).toContain('PREVIEW_CANCELLED')
  expect((await w.finish(802)).backend).toBe('webgpu')
  expect((await w.finish(803)).backend).toBe('webgpu')
  expect(state.renders).toHaveLength(3)
})
