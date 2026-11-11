import { afterEach, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { color_encode_png, encode_png_rgba, VectorEngine } from '../generated/design-kernel/design_kernel'
import { blank, node, paint, effect } from '../model'
import { documentPatch } from '../document-patch'
import { createRenderPolicy } from './render-policy'

const state = vi.hoisted(() => ({
  poseTiles: false, replacements: [] as number[],
  failAttach: false, failBudgetOnce: false, renders: [] as { readback: boolean; present: boolean; scene: any }[], transfers: [] as any[],
  keys: [] as { uri: string; variant: string; settings: string }[], reads: [] as string[],
  scenes: [] as any[], loads: [] as { uri: string; render: number; bytes?: Uint8Array; pixels: Float32Array }[],
  readGate: undefined as undefined | Promise<unknown>, keyGate: undefined as undefined | Promise<void>,
  renderGate: undefined as undefined | Promise<void>, renderBlocked: false, bitmaps: [] as any[],
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
      return { driver: { name: backend, managed: floating, displayMath, lost: false, description: 'CPU test driver', replacePresented: (slot: number) => { state.replacements.push(slot); return true }, attachPresenter: vi.fn(() => { if (state.failAttach) throw Error('Presenter attachment failed') }), abortFrameAndReleaseFilterScratch: async () => {} },
        dispose() { expect(state.disposed).not.toContain(identity); state.disposed.push(identity); resources.dispose() },
        abortFrameAndReleaseFilterScratch: async () => {},
        releaseFilterBatch() {},
        hasUploadedImageSource: (scene: any, uri: string) => resources.hasUploadedImageSource(scene, uri),
        async render(scene: any, readback = false, present = true, _current?:()=>boolean, _progress?:unknown, _pacing?:boolean, onFinishStarted?:()=>void) {
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
          onFinishStarted?.()
          if (state.renderGate) { state.renderBlocked = true; await state.renderGate }
          // Mock transport only. Pixel/texture equivalence is separately tested
          // with the real WASM and production GpuRenderer upload path.
          if (!readback && present && (globalThis as any).__mockBitmapPreview) {
            const bitmap = { width: scene.width, height: scene.height, close: vi.fn() }
            state.bitmaps.push(bitmap)
            return { description: backend, bitmap, drawCalls: 0, triangles: 0 }
          }
          if(state.poseTiles) return { description: backend, gpuTile: 77, drawCalls: 0, triangles: 0 }
          return { description: backend, rgba: new Uint8Array((scene.presentation?.width ?? scene.resolve?.width ?? scene.width) *
            (scene.presentation?.height ?? scene.resolve?.height ?? scene.height) * 4), drawCalls: 0, triangles: 0 }
        },
      }
    },
  }
})
const channels: MessageChannel[] = []
const NativeMessageChannel = MessageChannel
const wasm = new Uint8Array(readFileSync(new URL('../../public/kernel/design_kernel_bg.wasm', import.meta.url)))
afterEach(() => { channels.splice(0).forEach(pair => { pair.port1.close(); pair.port2.close() }); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })
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
async function worker(desktopFullMath = false, withPreparation = false, desktopDisplay = false) {
  vi.resetModules()
  Object.assign(state, { poseTiles: false, replacements: [], failAttach: false, failBudgetOnce: false, renders: [], transfers: [], keys: [], reads: [], scenes: [], loads: [], keyGate: undefined, readGate: undefined, renderGate: undefined, renderBlocked: false, bitmaps: [], disposed: [], createCount: 0, onPost: undefined })
  state.font = withPreparation ? new Uint8Array(readFileSync(new URL('../../public/fonts/NotoSansSC.ttf', import.meta.url))) : undefined
  const kernel = await import('../generated/design-kernel/design_kernel')
  await (await import('./module')).initializeKernelModule(wasm)
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
  const executionPolicy = createRenderPolicy(false, false, false, false, desktopFullMath, desktopDisplay)
  const send = (request: any) => scope.onmessage({ data: { executionPolicy, backend: 'auto', ...request } })
  const finish = async (id: number) => {
    // Asset reuse waits for worker completion; GUI acceptance measures latency.
    await vi.waitFor(() => expect(messages.some(value => value.id === id && (value.backend || value.error))).toBe(true), { timeout: 10_000 })
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

function nativePreviewHost() {
  vi.stubEnv('VITE_DESIGN_NATIVE_PREVIEW_TILES', '1')
  vi.stubEnv('VITE_DESIGN_NATIVE_NAVIGATION', '1')
  vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX', '1')
  vi.stubGlobal('__mockBitmapPreview', true)
  const publish = vi.fn(function (this: { width: number; height: number }) {
    return { width: this.width, height: this.height, close: vi.fn() }
  })
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(public width: number, public height: number) {}
    getContext() { return { drawImage: vi.fn(), imageSmoothingEnabled: false } }
    transferToImageBitmap = publish
  })
  return publish
}

test.each(['large', 'small', 'flag-off', 'fallback-off'] as const)('native preview tiles %s uses the actual worker route before any whole GPU graph', async variant => {
  const publish = nativePreviewHost(), f = fixture(4), w = await worker(true, false, true)
  const compile = vi.spyOn(w.kernel.VectorEngine.prototype, 'compile_gpu_packet')
  if (variant === 'flag-off') vi.stubEnv('VITE_DESIGN_NATIVE_PREVIEW_TILES', '0')
  const large = variant !== 'small', selected = variant === 'large'
  const options = { ...f.options, width: large ? 1050 : 1024, height: large ? 1000 : 1024,
    transparent: false, rasterProfile: 'figmaSubpixel', view: { x: -.25, y: .75, zoom: 32 },
    livePreview: true, previewTileFallback: variant !== 'fallback-off', renderIntent: 'preview' }
  w.send({ command: 'display-attach', canvas: {} })
  w.send({ id: 301, backend: 'webgpu', document: JSON.stringify(f.doc), documentRevision: 1, options })
  const result = await w.finish(301)
  expect(result.error).toBeUndefined(); expect(result.bitmap).toBeDefined()
  expect(result.bitmap.width).toBe(options.width); expect(result.bitmap.height).toBe(options.height)
  expect(state.renders.every(render => !render.readback && render.present && render.scene.displayFilters === false)).toBe(true)
  expect(state.renders.every(render => JSON.stringify(render.scene.view) === JSON.stringify(options.view))).toBe(true)
  if (selected) {
    expect(result.previewLane).toBe('regional-fallback'); expect(state.renders.length).toBeGreaterThan(1)
    expect(state.renders.every(render => render.scene.output && render.scene.output.w <= 256 && render.scene.output.h <= 256)).toBe(true)
    expect(compile.mock.calls.length).toBeGreaterThan(1)
    expect(compile.mock.calls.every(([wire]) => {
      const options = JSON.parse(wire)
      return options.gpuViewport && options.gpuViewport.w <= 256 && options.gpuViewport.h <= 256
    })).toBe(true)
    expect(publish).toHaveBeenCalledOnce(); expect(state.bitmaps.every(bitmap => bitmap.close.mock.calls.length === 1)).toBe(true)
  } else {
    expect(result.previewLane).toBe('whole-scene'); expect(state.renders).toHaveLength(1)
    expect(state.renders[0].scene.output).toBeUndefined(); expect(publish).not.toHaveBeenCalled()
    expect(compile).toHaveBeenCalledOnce(); expect(JSON.parse(compile.mock.calls[0][0]).gpuViewport).toBeUndefined()
  }
  expect(state.createCount).toBe(1); expect(state.disposed).toEqual([])
})

test('native preview tiles cancellation closes its leaf and never publishes a partial assembly or compiles the next region', async () => {
  const publish = nativePreviewHost(), f = fixture(4), w = await worker(true, false, true)
  const compile = vi.spyOn(w.kernel.VectorEngine.prototype, 'compile_gpu_packet')
  let resume!: () => void
  state.renderGate = new Promise<void>(resolve => { resume = resolve })
  w.send({ command: 'display-attach', canvas: {} })
  w.send({ id: 302, backend: 'webgpu', document: JSON.stringify(f.doc), documentRevision: 1,
    options: { ...f.options, width: 1050, height: 1000, transparent: false, rasterProfile: 'figmaSubpixel',
      livePreview: true, previewTileFallback: true, renderIntent: 'preview' } })
  await vi.waitFor(() => expect(state.renderBlocked).toBe(true))
  expect(state.renders).toHaveLength(1)
  expect(state.renders[0].scene.output).toBeDefined()
  expect(w.messages.some(value => value.id === 302 && (value.backend || value.error))).toBe(false)
  w.send({ command: 'cancel-request', requestId: 302 })
  resume()
  const result = await w.finish(302)
  expect(result.error).toContain('PREVIEW_CANCELLED'); expect(state.renders).toHaveLength(1)
  expect(compile).toHaveBeenCalledOnce(); expect(JSON.parse(compile.mock.calls[0][0]).gpuViewport).toBeDefined()
  expect(publish).not.toHaveBeenCalled(); expect(state.bitmaps).toHaveLength(1)
  expect(state.bitmaps[0].close).toHaveBeenCalledOnce()
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

// Real worker/native scene path; GPU transport deliberately mocked. These
// assertions certify queue/pose ownership, not physical display or GPU pixels.
async function affineWorker(affine=true,masked=false,fixedMaskWidth?:number) {
  const f = fixture(1), w = await worker(); state.poseTiles = true
  if(masked){
    const group=node('group',0,0,48,16),mask=node('rectangle',0,0,48,16)
    f.doc.schemaVersion=20
    mask.mask=true;mask.maskType='shape'
    group.children=[mask.id,'image-0']
    f.doc.nodes[group.id]=group;f.doc.nodes[mask.id]=mask;f.doc.pages[0].children=[group.id]
  }
  const options = { ...f.options, renderIntent: 'preview', livePreview: true,
    retainInteractionGraph: true, interactionNative: true, interactionAffine: affine,
    interactionFixedMask: fixedMaskWidth !== undefined,
    interactionSelection: ['image-0'], interactionWindowFixed: true,
    interactionWindow: { x: 0, y: 0, w: fixedMaskWidth ?? 48, h: 16 } }
  w.send({ id: 980, channel: 'interaction', document: JSON.stringify(f.doc), documentRevision: 1, options })
  const capture=await w.finish(980)
  expect(capture.error).toBeUndefined()
  expect(capture.residentInteraction).toBe(true)
  const pose = (sequence: number) => ({ command: 'interaction-pose', slot: 77, input: { owner: 'affine-test', sequence, at: 0 },
    transforms: { 'image-0': affine
      ? [Math.cos(sequence / 10), Math.sin(sequence / 10), -Math.sin(sequence / 10), Math.cos(sequence / 10), 4, 2]
      : [1, 0, 0, 1, sequence * 4, 2] } })
  return { ...w, f, options, pose }
}
test('affine worker compiles the latest absolute pose and never acknowledges skipped queued inputs', async () => {
  const w = await affineWorker()
  w.send(w.pose(1)); w.send(w.pose(2)); w.send(w.pose(3))
  await vi.waitFor(() => expect(w.messages.some(m => m.presentation?.residentSample?.sequence === 3)).toBe(true))
  expect(w.messages.some(m => m.presentation?.residentSample?.sequence === 2)).toBe(false)
  expect(state.scenes.at(-1).nodes['image-0'].matrix).toEqual(w.pose(3).transforms['image-0'])
  expect(state.replacements.length).toBeLessThanOrEqual(2)
})

test('a full native viewport prepares the released affine pose while the obsolete GPU work drains', async () => {
  const w = await affineWorker()
  w.send({ command: 'display-frame', sequence: 1, frame: {
    view: { x: 0, y: 0, zoom: 1 }, width: 48, height: 16, dpr: 1, items: [],
  } })
  const sample = (sequence: number) => w.messages.find(m => m.presentation?.residentSample?.sequence === sequence)?.presentation.residentSample
  w.send(w.pose(1))
  await vi.waitFor(() => expect(sample(1)?.nativePose).toBe(true))
  const compile = vi.spyOn(w.kernel.VectorEngine.prototype, 'compile_gpu_packet')
  let release!: () => void
  state.renderGate = new Promise<void>(resolve => { release = resolve })
  try {
    w.send(w.pose(2))
    await vi.waitFor(() => expect(state.renderBlocked).toBe(true))
    const terminal = { ...w.pose(1), input: w.pose(3).input, terminal: true }
    w.send(terminal)
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2))
    expect(state.replacements).toHaveLength(1)
    state.renderGate = undefined
    release()
    await vi.waitFor(() => expect(sample(3)?.nativePose).toBe(true))
    expect(sample(2)).toBeUndefined()
    expect(compile).toHaveBeenCalledTimes(2)
    expect(state.scenes.at(-1).nodes['image-0'].matrix).toEqual(terminal.transforms['image-0'])
  } finally {
    state.renderGate = undefined
    release()
    compile.mockRestore()
  }
})
test.each([[true, true], [true, false], [false, true], [false, false]])(
  'a declined native pose keeps its lease only when it covers the display (affine=%s, full=%s)', async (affine, coversDisplay) => {
  const w = await affineWorker(affine,true)
  w.send({ command: 'display-frame', sequence: 1, frame: {
    view: { x: 0, y: 0, zoom: 1 }, width: coversDisplay ? 48 : 56, height: 16,
    dpr: 1, items: [],
  } })
  w.send(w.pose(1))
  await vi.waitFor(() => expect(w.messages.some(m => m.presentation?.residentSample?.sequence === 1)).toBe(true))
  const sample=w.messages.find(m=>m.presentation?.residentSample?.sequence===1).presentation.residentSample
  expect(!!sample.needsRebase).toBe(!coversDisplay)
  expect(state.replacements).toHaveLength(coversDisplay ? 1 : 0)
  if(coversDisplay)expect(state.scenes.at(-1).nodes['image-0'].matrix).toEqual(w.pose(1).transforms['image-0'])
})
test.each([true, false])('a partial viewport reuses a native pose only when the window encloses its fixed mask (%s)', async coversMask => {
  const w = await affineWorker(true, true, coversMask ? 48 : 47)
  w.send({ command: 'display-frame', sequence: 1, frame: {
    view: { x: 0, y: 0, zoom: 1 }, width: 56, height: 16, dpr: 1, items: [],
  } })
  w.send(w.pose(1))
  await vi.waitFor(() => expect(w.messages.some(m => m.presentation?.residentSample?.sequence === 1)).toBe(true))
  const sample = w.messages.find(m => m.presentation?.residentSample?.sequence === 1).presentation.residentSample
  expect(!!sample.needsRebase).toBe(!coversMask)
  expect(state.replacements).toHaveLength(coversMask ? 1 : 0)
  if (coversMask) expect(state.scenes.at(-1).nodes['image-0'].matrix).toEqual(w.pose(1).transforms['image-0'])
})
test.each([true, false])('a stopped masked pose restores the displayed document before a new capture (affine=%s)', async affine => {
  const w = await affineWorker(affine,true)
  w.send({ command: 'display-frame', sequence: 1, frame: {
    view: { x: 0, y: 0, zoom: 1 }, width: 48, height: 16, dpr: 1, items: [],
  } })
  let release!:()=>void
  state.renderGate=new Promise(resolve=>{release=resolve})
  w.send(w.pose(1))
  await vi.waitFor(()=>expect(state.renderBlocked).toBe(true))
  w.send({command:'interaction-pose-stop',slot:77})
  state.renderGate=undefined
  release()
  w.send({id:981,channel:'interaction',documentRevision:1,options:w.options})
  expect((await w.finish(981)).error).toBeUndefined()
  expect(state.replacements).toHaveLength(0)
  expect(state.scenes.at(-1).nodes['image-0'].matrix).toEqual(w.f.doc.nodes['image-0'].transform)
})
test('a committed masked pose supersedes obsolete GPU work in the same viewport', async () => {
  const w = await affineWorker(true,true)
  w.send({command:'display-frame',sequence:1,frame:{
    view:{x:0,y:0,zoom:1},width:48,height:16,dpr:1,items:[],
  }})
  let release!:()=>void
  state.renderGate=new Promise(resolve=>{release=resolve})
  w.send(w.pose(1))
  await vi.waitFor(()=>expect(state.renderBlocked).toBe(true))
  w.send({...w.pose(2),terminal:true})
  state.renderGate=undefined
  release()
  await vi.waitFor(()=>expect(w.messages.some(m=>m.presentation?.residentSample?.sequence===2)).toBe(true))
  expect(w.messages.some(m=>m.presentation?.residentSample?.sequence===1)).toBe(false)
  expect(state.replacements).toEqual([77])
  expect(state.scenes.at(-1).nodes['image-0'].matrix).toEqual(w.pose(2).transforms['image-0'])
})
test('native pose preparation failure retires the lease and leaves the next capture and input usable', async () => {
  const w = await affineWorker(), warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const apply = vi.spyOn(w.kernel.VectorEngine.prototype, 'apply_interaction_transforms').mockImplementationOnce(() => { throw Error('simulated preparation failure') })
  w.send(w.pose(1))
  await vi.waitFor(() => expect(w.messages.some(m => m.presentation?.residentSample?.needsRebase && m.presentation.residentSample.sequence === 1)).toBe(true))
  expect(w.messages.some(m => m.presentation?.residentSample?.sequence === 1 && !m.presentation.residentSample.needsRebase)).toBe(false)
  apply.mockRestore()
  w.send({ id: 981, channel: 'interaction', document: JSON.stringify(w.f.doc), documentRevision: 2, options: w.options })
  expect((await w.finish(981)).error).toBeUndefined()
  w.send(w.pose(2)); await vi.waitFor(() => expect(w.messages.some(m => m.presentation?.residentSample?.sequence === 2)).toBe(true))
  expect(warn).toHaveBeenCalled()
})
test('stopping a pose during raster drops completion and queued inputs without replacing the visible slot', async () => {
  const w = await affineWorker(); let release!: () => void
  state.renderGate = new Promise(resolve => { release = resolve })
  w.send(w.pose(1)); await vi.waitFor(() => expect(state.renderBlocked).toBe(true))
  w.send(w.pose(2)); w.send({ command: 'interaction-pose-stop', slot: 77 }); release()
  w.send({ id: 981, channel: 'interaction', document: JSON.stringify(w.f.doc), documentRevision: 2, options: w.options })
  expect((await w.finish(981)).error).toBeUndefined()
  expect(w.messages.some(m => m.presentation?.residentSample)).toBe(false); expect(state.replacements).toEqual([])
})

test('live capture document patches route pure affine transforms through native retention before compiling exact content',async()=>{
 const w=await affineWorker(),transform=[0,1,-1,0,24,2] as [number,number,number,number,number,number]
 const next={...w.f.doc,nodes:{...w.f.doc.nodes,'image-0':{...w.f.doc.nodes['image-0'],transform}}}
 const apply=vi.spyOn(w.kernel.VectorEngine.prototype,'apply_interaction_transforms')
 w.send({id:981,channel:'interaction',documentPatch:JSON.stringify(documentPatch(w.f.doc,next)),baseDocumentRevision:1,documentRevision:2,options:w.options})
 expect((await w.finish(981)).error).toBeUndefined()
 expect(apply).toHaveBeenCalled()
 const poseDamage=w.messages.find(m=>m.id===981&&m.damage)?.damage
 expect(poseDamage.reason).toBe('native-interaction-pose')
 expect(poseDamage.full).toBe(false)
 expect(poseDamage.bounds?.[2]).toBeGreaterThan(0)
 expect(state.scenes.at(-1).nodes['image-0'].matrix).toEqual(transform)
})

test.each(['same','changed','foreign'] as const)('release %s pose supersedes only matching owned preparations before GPU work',async kind=>{
 const w=await affineWorker(false)
 const pose=(sequence:number,x:number,owner='owner')=>({command:'interaction-pose',slot:77,
  input:{owner,sequence,at:sequence},transforms:{'image-0':[1,0,0,1,x,0]}})
 const original=w.kernel.VectorEngine.prototype.apply_interaction_transforms
 const apply=vi.spyOn(w.kernel.VectorEngine.prototype,'apply_interaction_transforms').mockImplementationOnce(function(this:VectorEngine,input:string){
  const owner=kind==='foreign'?'other':'owner'
  w.send(pose(2,kind==='same'?2:4,owner))
  w.send({command:'interaction-settle',slot:77,sequence:2,owner})
  return original.call(this,input)
 })
 try{
  w.send(pose(1,2))
  await vi.waitFor(()=>expect(w.messages.some(m=>m.presentation?.residentSample?.sequence===2)).toBe(true))
  expect(state.replacements.length).toBe(kind==='foreign'?2:1)
  expect(w.messages.some(m=>m.presentation?.residentSample?.sequence===1)).toBe(kind==='foreign')
  expect(state.scenes.at(-1).nodes['image-0'].matrix[4]).toBe(kind==='same'?2:4)
 }finally{apply.mockRestore()}
})

test.each(['consume','stop','foreign','compile failure'] as const)('terminal CPU handoff under an owned GPU finish fence: %s',async mode=>{
  const w=await worker(), f=fixture(0)
  f.doc.schemaVersion=16
  const shape=node('vector',0,0,12,12);shape.id='inner';delete shape.network
  shape.vectorGeometry={fillRule:'nonzero',fill:[{move:[0,0]},{line:[10,0]},{line:[6,10]},'close']}
  shape.fills=[paint('#ace0ff')];shape.strokes=[];shape.effects=[effect('inner-shadow')]
  f.doc.nodes[shape.id]=shape;f.doc.pages[0].children=[shape.id]
  const doc=JSON.stringify(f.doc),canvas={...f.options,rasterProfile:'figmaSubpixel'}
  w.send({id:700,channel:'canvas',document:doc,documentRevision:1,options:canvas,readback:true})
  expect((await w.finish(700)).error).toBeUndefined()
  state.poseTiles=true
  const options={...canvas,renderIntent:'preview',livePreview:true,retainInteractionGraph:true,interactionNative:true,
    interactionAffine:true,interactionLocalFootprint:true,interactionBranch:3,interactionWindowFixed:true,
    interactionSelection:['inner'],interactionWindow:{x:0,y:0,w:48,h:16}}
  w.send({id:701,channel:'interaction',document:doc,documentRevision:1,options})
  expect((await w.finish(701)).residentInteraction).toBe(true)
  const make=(sequence:number,angle:number,owner='same')=>({command:'interaction-pose',slot:77,input:{owner,sequence,at:sequence},
    transforms:{inner:[Math.cos(angle),Math.sin(angle),-Math.sin(angle),Math.cos(angle),4,2]}})
  const first=make(1,.1), last=make(2,.2,mode==='foreign'?'foreign':'same')
  const apply=vi.spyOn(w.kernel.VectorEngine.prototype,'apply_interaction_transforms')
  const compile=vi.spyOn(w.kernel.VectorEngine.prototype,'compile_gpu_packet')
  let resume!:()=>void;state.renderGate=new Promise<void>(resolve=>{resume=resolve})
  try{
    w.send(first);await vi.waitFor(()=>expect(state.renderBlocked).toBe(true))
    if(mode==='compile failure')compile.mockImplementationOnce(()=>{throw Error('synthetic terminal compilation failure')})
    w.send(last);w.send({command:'interaction-settle',slot:77,sequence:2,owner:last.input.owner})
    if(mode==='foreign'){
      await new Promise(resolve=>setTimeout(resolve,10));expect(apply).toHaveBeenCalledTimes(1)
    }else{
      await vi.waitFor(()=>expect(compile).toHaveBeenCalledTimes(2))
      expect(state.replacements).toHaveLength(0)
    }
    if(mode==='stop'||mode==='foreign')w.send({command:'interaction-pose-stop',slot:77})
    if(mode==='consume')w.send({...make(3,.2),terminal:true})
    state.renderGate=undefined;resume()
    const sample=(seq:number)=>w.messages.filter(m=>m.presentation?.residentSample?.sequence===seq).map(m=>m.presentation.residentSample)
    if(mode==='consume'){
      await vi.waitFor(()=>expect(sample(3).some(s=>!s.needsRebase)).toBe(true))
      expect(compile).toHaveBeenCalledTimes(2);expect(apply).toHaveBeenCalledTimes(2)
      expect(sample(1).filter(s=>!s.needsRebase)).toHaveLength(0)
      expect(state.scenes.at(-1).nodes.inner.matrix).toEqual(last.transforms.inner)
    }else{
      if(mode==='compile failure')await vi.waitFor(()=>expect(sample(2).some(s=>s.needsRebase)).toBe(true))
      w.send({id:702,channel:'interaction',document:doc,documentRevision:2,options})
      expect((await w.finish(702)).residentInteraction).toBe(true)
      expect(sample(2).filter(s=>!s.needsRebase)).toHaveLength(0)
      if(mode!=='foreign'){
        expect(apply).toHaveBeenCalledTimes(3)
        expect(JSON.parse(apply.mock.calls.at(-1)![0])).toEqual(first.transforms)
      }
    }
  }finally{state.renderGate=undefined;resume();apply.mockRestore();compile.mockRestore()}
})
