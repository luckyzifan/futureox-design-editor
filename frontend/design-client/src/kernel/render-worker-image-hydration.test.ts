import { afterEach, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { color_encode_png, encode_png_rgba, VectorEngine } from '../generated/design-kernel/design_kernel'
import { blank, node, paint } from '../model'
import { documentPatch } from '../document-patch'
import { createRenderPolicy } from './render-policy'

const state = vi.hoisted(() => ({
  keys: [] as { uri: string; variant: string; settings: string }[], reads: [] as string[],
  scenes: [] as any[], loads: [] as { uri: string; render: number; bytes?: Uint8Array; pixels: Float32Array }[],
  readGate: undefined as undefined | Promise<unknown>, keyGate: undefined as undefined | Promise<void>,
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
vi.mock('./kernel-resources', () => ({ loadKernelResources: async () => undefined }))
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
      return { driver: { name: backend, managed: floating, displayMath, lost: false, description: 'CPU test driver' },
        dispose() { expect(state.disposed).not.toContain(identity); state.disposed.push(identity); resources.dispose() },
        async render(scene: any) {
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
async function worker(desktopFullMath = false) {
  vi.resetModules()
  Object.assign(state, { keys: [], reads: [], scenes: [], loads: [], keyGate: undefined, readGate: undefined, disposed: [], createCount: 0, onPost: undefined })
  const kernel = await import('../generated/design-kernel/design_kernel')
  await kernel.default({ module_or_path: wasm })
  const messages: any[] = [], scope: any = { postMessage(value: unknown) { messages.push(value); state.onPost?.(value) } }
  vi.stubGlobal('self', scope)
  vi.stubGlobal('MessageChannel', class {
    constructor() { const channel = new NativeMessageChannel(); channels.push(channel); return channel }
  })
  await import('./render-worker')
  const executionPolicy = createRenderPolicy(false, false, false, false, desktopFullMath)
  const send = (request: any) => scope.onmessage({ data: { executionPolicy, backend: 'auto', ...request } })
  const finish = async (id: number) => {
    await vi.waitFor(() => expect(messages.some(value => value.id === id && (value.backend || value.error))).toBe(true))
    return messages.find(value => value.id === id && (value.backend || value.error))
  }
  return { send, finish, messages }
}

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
