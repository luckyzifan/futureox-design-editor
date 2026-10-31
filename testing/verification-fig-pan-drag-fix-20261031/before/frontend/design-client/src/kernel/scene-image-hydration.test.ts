import { expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { stripTypeScriptTypes } from 'node:module'
import { DecodedImageCache, createDecodedImageOwner, decodedImageScope, type DecodedImage } from './decoded-image-cache'
import { managedSceneImageLoader, SceneImageHydration, type ImageContext, type ImagePersistence } from './scene-image-hydration'
import { sceneIndex } from './gpu/scene-index'
import type { GpuScene } from './gpu/types'
import { GpuRenderer } from './gpu/renderer'
import { decodeScenePacket } from './gpu/scene-packet'
import { RenderWorkQueue } from './render-work-queue'
import { VectorEngine, encode_png_rgba } from '../generated/design-kernel/design_kernel'
import { blank, node, paint, type DesignDocument } from '../model'
import { defaultColorSettings } from '../color'

const uri = (n: number) => `data:image/png;base64,${n}`
const record = (linear = false): DecodedImage => ({ width: 2, height: 2,
  data: linear ? new Float32Array(16).fill(0.125) : new Uint8Array(16).fill(32) })
function scene(uris: string[], linear = false): GpuScene {
  return { version: 8, width: 16, height: 16, extent: { x: 0, y: 0, w: 16, h: 16 },
    view: { x: 0, y: 0, zoom: 1 }, transparent: true, background: '#ffffff', grid: false,
    roots: uris.map((_, i) => String(i)), vertices: [], floatCompositing: linear,
    nodes: Object.fromEntries(uris.map((image, i) => [String(i), { id: String(i), children: [],
      fills: [{ ...paint('#ffffff'), kind: 'image', image }], strokes: [], effects: [], matrix: [1, 0, 0, 1, 0, 0] }])) } as unknown as GpuScene
}
const decoder = () => ({ image_info: vi.fn(() => '[2,2]'), image_info_at_level: vi.fn(() => '[1,1]'),
  image_rgba8: vi.fn(() => record().data as Uint8Array), image_linear: vi.fn(() => record(true).data as Float32Array),
  image_rgba8_at_level: vi.fn(() => new Uint8Array(4)), image_linear_at_level: vi.fn(() => new Float32Array(4)) })
function setup(options: { limit?: number; current?: () => boolean; owner?: () => boolean; read?: ImagePersistence['read'] } = {}) {
  const cache = new DecodedImageCache(options.limit), kernel = decoder()
  const context: ImageContext = { kernel, settings: 'null', scope: 'canvas:1:doc:null', current: options.current }
  const persistence = { key: vi.fn(async (uri: string, variant: string, settings: string): Promise<string | undefined> => `${variant}:${settings}:${uri}`),
    read: vi.fn(options.read ?? (async key => record(key.startsWith('linear')))), write: vi.fn() }
  const hydration = new SceneImageHydration(cache, context, persistence, options.owner ?? (() => true), options.current)
  const load = managedSceneImageLoader(cache, () => context, persistence)
  return { cache, context, kernel, persistence, hydration, load }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }

for (const linear of [false, true]) test(`one compiled scene reads unique dependencies in only ${linear ? 'linear' : 'byte'} format`, async () => {
  const s = setup(), compiled = scene([uri(1), uri(2), uri(1)], linear)
  await s.hydration.hydrate(compiled); await s.hydration.hydrate(compiled)
  expect(s.persistence.read).toHaveBeenCalledTimes(2)
  expect(s.persistence.key.mock.calls.map(args => args[1])).toEqual([linear ? 'linear' : 'byte', linear ? 'linear' : 'byte'])
  const loaded = s.load(uri(1), !linear)
  expect(linear ? loaded.pixels : loaded.bytes).toEqual(record(linear).data)
  expect(s.kernel.image_info).not.toHaveBeenCalled()
})

test('color management selects linear even without floatCompositing, and later tile format changes remain independent', async () => {
  const s = setup(), compiled = scene([uri(1)])
  compiled.colorManagement = defaultColorSettings()
  await s.hydration.hydrate(compiled); await s.hydration.hydrate(scene([uri(1)]))
  expect(s.persistence.key.mock.calls.map(args => args[1])).toEqual(['linear', 'byte'])
})

test('concurrent callers serialize one pending read, including a miss', async () => {
  const pending = deferred<DecodedImage | undefined>(), s = setup({ read: () => pending.promise })
  const first = s.hydration.hydrate(scene([uri(1)])), second = s.hydration.hydrate(scene([uri(1)]))
  await vi.waitFor(() => expect(s.persistence.read).toHaveBeenCalledTimes(1))
  pending.resolve(undefined); await Promise.all([first, second])
  expect(s.persistence.read).toHaveBeenCalledTimes(1)
  expect(s.load(uri(1), true).bytes).toEqual(record().data)
  expect(s.kernel.image_info).toHaveBeenCalledTimes(1)
})

test('cancellation after key hashing schedules no store read or synchronous decode', async () => {
  let current = true
  const pending = deferred<string | undefined>(), s = setup({ current: () => current })
  s.persistence.key.mockImplementation(() => pending.promise)
  const task = s.hydration.hydrate(scene([uri(1), uri(2)])), rejection = expect(task).rejects.toThrow('PREVIEW_CANCELLED')
  await vi.waitFor(() => expect(s.persistence.key).toHaveBeenCalledOnce())
  current = false; pending.resolve('key'); await rejection
  expect(s.persistence.read).not.toHaveBeenCalled()
  expect(() => s.load(uri(1), true)).toThrow('PREVIEW_CANCELLED')
  expect(s.kernel.image_info).not.toHaveBeenCalled()
})

test('three canceled reads cannot clear or repopulate a same-id reopened owner', async () => {
  const cache = new DecodedImageCache()
  for (let generation = 0; generation < 3; generation++) {
    let current = true
    const pending = deferred<DecodedImage | undefined>(), kernel = decoder()
    const persistence = { key: async () => 'old', read: () => pending.promise, write() {} }
    const hydration = new SceneImageHydration(cache, { kernel, scope: 'same-document', settings: 'null' }, persistence, () => current)
    const task = hydration.hydrate(scene([uri(1)])), rejection = expect(task).rejects.toThrow('PREVIEW_CANCELLED')
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    current = false
    cache.begin('new-owner'); const fresh = record(); fresh.data[0] = generation + 1
    cache.set('new-owner', 'fresh', fresh)
    pending.resolve(record()); await rejection
    expect(cache.get('new-owner', 'fresh')).toBe(fresh)
    expect(cache.size).toBe(1)
  }
})

for (const failure of ['miss', 'reject', 'malformed', 'wrong-variant'] as const) test(`${failure} falls back to exact original decoder without a placeholder`, async () => {
  const s = setup({ read: async () => {
    if (failure === 'reject') throw Error('storage unavailable')
    if (failure === 'malformed') return { width: 2, height: 2, data: new Uint8Array(4) }
    return failure === 'wrong-variant' ? record(true) : undefined
  } })
  await s.hydration.hydrate(scene([uri(1)]))
  expect(s.load(uri(1), true).bytes).toEqual(record().data)
  expect(s.kernel.image_rgba8).toHaveBeenCalledOnce()
})

test('read work and residency remain bounded; over-budget images still use full-resolution decoder', async () => {
  const s = setup({ limit: 640, read: async () => ({ width: 8, height: 8, data: new Uint8Array(256) }) })
  await s.hydration.hydrate(scene([uri(1), uri(2), uri(3), uri(4)]))
  expect(s.persistence.read).toHaveBeenCalledTimes(3)
  expect(s.cache.bytes).toBeLessThanOrEqual(640)
  const large = setup({ limit: 1024, read: async () => ({ width: 1, height: 1, data: new Uint8Array(new ArrayBuffer(2048), 0, 4) }) })
  await large.hydration.hydrate(scene([uri(1), uri(2)]))
  expect(large.persistence.read).toHaveBeenCalledOnce()
  expect(large.cache.size).toBe(0)
  expect(large.load(uri(1), true).bytes).toEqual(record().data)
  expect(large.kernel.image_info).toHaveBeenCalledOnce()
})

test('request entry and key-string budgets stop optional hashing without rejecting a valid source', async () => {
  const s = setup(), hydration = new SceneImageHydration(s.cache, s.context, s.persistence, () => true, () => true,
    { entries: 2, keyBytes: 2048, readBytes: 4096 })
  await hydration.hydrate(scene([uri(1), uri(2), uri(3)]))
  expect(s.persistence.key).toHaveBeenCalledTimes(2)
  expect(s.load(uri(3), true).bytes).toEqual(record().data)
  const short = new SceneImageHydration(s.cache, s.context, s.persistence, () => true, () => true,
    { entries: 1000, keyBytes: 1, readBytes: 4096 })
  await short.hydrate(scene([uri(4)])); expect(s.persistence.key).toHaveBeenCalledTimes(3) // third is write-back
})

test('borrowed image pixels survive eviction and mips keep their exact requested level', async () => {
  const s = setup({ limit: 500 })
  await s.hydration.hydrate(scene([uri(1)])); const borrowed = s.load(uri(1), true).bytes!
  s.cache.begin('another lane')
  expect(borrowed).toEqual(record().data)
  s.load(uri(1), true, 2); s.load(uri(1), false, 3)
  expect(s.kernel.image_rgba8_at_level).toHaveBeenCalledWith(uri(1), 2)
  expect(s.kernel.image_linear_at_level).toHaveBeenCalledWith(uri(1), 3)
})

test('invalid source still reaches the production renderer validation', async () => {
  const s = setup(), compiled = scene(['https://untrusted.example/image.png'])
  await s.hydration.hydrate(compiled)
  expect(s.persistence.read).not.toHaveBeenCalled()
  const renderer = new GpuRenderer({ scratchBytes: 0 } as any, true, true, s.load) as any
  await expect(renderer.loadImages(compiled)).rejects.toThrow('无效的 GPU 图片资源')
  expect(s.kernel.image_info).not.toHaveBeenCalled()
})

function baseline(persistence: ImagePersistence, documentId: string) {
  const base = new URL('../../../../testing/verification-image-hydration-20261019/', import.meta.url)
  const source = readFileSync(new URL('baseline-image-cache.txt', base), 'utf8')
  const manifest = JSON.parse(readFileSync(new URL('baseline.json', base), 'utf8'))
  expect(createHash('sha256').update(source).digest('hex')).toBe(manifest.excerptSha256)
  return new Function('DecodedImageCache', 'imageCacheKey', 'readCachedImage', 'writeCachedImage', 'loadedDocumentId',
    stripTypeScriptTypes(source, { mode: 'strip' }) + '\nreturn { warmImageCache, managedImageLoader };')(
      DecodedImageCache, persistence.key, persistence.read, persistence.write, documentId) as {
        warmImageCache(kernel: VectorEngine, doc: DesignDocument): Promise<void>
        managedImageLoader(kernel: VectorEngine): ReturnType<typeof managedSceneImageLoader>
      }
}
function fixture(count = 1000, managed = false) {
  const doc = blank('Reproducible image hydration fixture')
  doc.id = 'image-hydration-fixture'; doc.pages[0].id = 'visible-page'
  if (managed) { doc.schemaVersion = 3; doc.colorManagement = { ...defaultColorSettings(), documentSpace: 'display-p3' }; doc.rasterProfile = 'figma' }
  doc.pages.push({ ...doc.pages[0], id: 'other-page', name: 'Other images', children: [] })
  const uris: string[] = []
  for (let i = 0; i < count; i++) {
    const rgba = new Uint8Array([i % 256, Math.floor(i / 256) % 256, (i * 37) % 256, 127 + i % 129])
    const image = `data:image/png;base64,${Buffer.from(encode_png_rgba(1, 1, rgba)).toString('base64')}`
    const n = node('rectangle', i % 4 * 12, 0, 12, 12)
    n.id = `image-${String(i).padStart(4, '0')}`
    n.fills = [{ ...paint('#ffffff'), id: `paint-${i}`, kind: 'image', image }]
    doc.nodes[n.id] = n; doc.pages[i < 4 ? 0 : 1].children.push(n.id); uris.push(image)
  }
  return { doc, uris, options: JSON.stringify({ pageId: doc.pages[0].id, width: 48, height: 16,
    view: { x: 0, y: 0, zoom: 1 }, transparent: true, rasterProfile: 'analytic' }) }
}
function recordingRenderer(load: ReturnType<typeof managedSceneImageLoader>, compiled: GpuScene) {
  const uploaded: Uint8Array[] = []
  const upload = (data: Uint8Array | Float32Array, width: number, height: number) => {
    uploaded.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice())
    return { width, height, bytes: data.byteLength, resource: {} }
  }
  const renderer = new GpuRenderer({ scratchBytes: 0, uploadRgba8: upload, uploadLinear: upload } as any, true, true, load) as any
  renderer.scene = compiled
  return { renderer, uploaded }
}

test('same-owner canvas and interaction decoders share immutable exact floats without disk or second WASM decode', async () => {
  const f = fixture(4, true), canvas = new VectorEngine(), interaction = new VectorEngine()
  try {
    canvas.load_document(JSON.stringify(f.doc)); interaction.load_document(JSON.stringify(f.doc))
    const owner = createDecodedImageOwner(), settings = canvas.color_settings(), scope = decodedImageScope(owner, settings)
    const cache = new DecodedImageCache(), persistence = { key: vi.fn(async () => undefined), read: vi.fn(async () => undefined), write: vi.fn() }
    let context: ImageContext = { kernel: canvas, scope, settings }
    const load = managedSceneImageLoader(cache, () => context, persistence), image = f.uris[1]
    const expected = canvas.image_linear(image), initial = load(image).pixels
    const before = new Uint32Array(initial.buffer, initial.byteOffset, initial.length).slice()
    const info = vi.spyOn(interaction, 'image_info'), pixels = vi.spyOn(interaction, 'image_linear')
    context = { kernel: interaction, scope: decodedImageScope(owner, interaction.color_settings()), settings }
    await new SceneImageHydration(cache, context, persistence, () => true).hydrate(scene([image], true))
    expect(load(image).pixels).toBe(initial)
    expect(info).not.toHaveBeenCalled(); expect(pixels).not.toHaveBeenCalled(); expect(persistence.read).not.toHaveBeenCalled()
    context = { kernel: canvas, scope, settings }
    expect(load(image).pixels).toBe(initial)
    expect(before).toEqual(new Uint32Array(expected.buffer, expected.byteOffset, expected.length))
    expect(new Uint32Array(initial.buffer, initial.byteOffset, initial.length)).toEqual(before)
  } finally { canvas.free(); interaction.free() }
})

test('a pending old lane read cannot fill shared residency after lane ownership changes', async () => {
  const cache = new DecodedImageCache(), owner = createDecodedImageOwner(), scope = decodedImageScope(owner, 'null')
  let lane = 'canvas'
  const pending = deferred<DecodedImage | undefined>(), context = { kernel: decoder(), scope, settings: 'null' }
  const hydration = new SceneImageHydration(cache, context, { key: async () => 'old', read: () => pending.promise, write() {} }, () => lane === 'canvas')
  const task = hydration.hydrate(scene([uri(1)])), rejection = expect(task).rejects.toThrow('PREVIEW_CANCELLED')
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  lane = 'interaction'; cache.begin(scope)
  const fresh = record(); fresh.data[0] = 99; cache.set(scope, `b:${uri(1)}`, fresh)
  pending.resolve(record()); await rejection
  expect(cache.get(scope, `b:${uri(1)}`)).toBe(fresh)
  expect(fresh.data[0]).toBe(99)
})

test('delayed persistence write retains captured URI/settings/pixels and never fills a new owner', async () => {
  const cache = new DecodedImageCache(), firstOwner = createDecodedImageOwner(), nextOwner = createDecodedImageOwner()
  const oldSettings = '{"referenceWhiteNits":100}', newSettings = '{"referenceWhiteNits":203}'
  const firstScope = decodedImageScope(firstOwner, oldSettings), nextScope = decodedImageScope(nextOwner, newSettings)
  const gate = deferred<string | undefined>(), kernel = decoder()
  let context = { kernel, scope: firstScope, settings: oldSettings }
  const persistence = { key: vi.fn(() => gate.promise), read: vi.fn(async () => undefined), write: vi.fn() }
  const load = managedSceneImageLoader(cache, () => context, persistence)
  const pixels = load(uri(1)).pixels
  context = { kernel, scope: nextScope, settings: newSettings }; cache.begin(nextScope)
  const fresh = record(true); fresh.data[0] = 4; cache.set(nextScope, `f:${uri(1)}`, fresh)
  gate.resolve('captured-old-key'); await Promise.resolve(); await Promise.resolve()
  expect(persistence.key).toHaveBeenCalledWith(uri(1), 'linear', oldSettings)
  expect(persistence.write).toHaveBeenCalledWith('captured-old-key', { width: 2, height: 2, data: pixels })
  expect(cache.get(nextScope, `f:${uri(1)}`)).toBe(fresh)
  expect(cache.get(firstScope, `f:${uri(1)}`)).toBeUndefined()
})

for (const managed of [false, true]) test(`real kernel packets and upload bytes equal baseline while 1000-image warm reads drop 2000 → 4 (managed=${managed})`, async () => {
  const { doc, uris, options } = fixture(1000, managed), source = JSON.stringify(doc)
  const kernel = new VectorEngine()
  try {
    kernel.load_document(source)
    const compiled = decodeScenePacket(kernel.compile_gpu_packet(options))
    expect(new Set(sceneIndex(compiled).images)).toEqual(new Set(uris.slice(0, 4)))
    const pixelsBefore = kernel.render_rgba(options), packetBefore = kernel.compile_gpu_packet(options)
    const records = new Map<string, DecodedImage>()
    for (const image of uris) for (const variant of managed ? ['linear'] : ['byte', 'linear']) records.set(`${variant}:${image}`,
      { width: 1, height: 1, data: variant === 'byte' ? kernel.image_rgba8(image) : kernel.image_linear(image) })
    const persistence = { key: vi.fn(async (image: string, variant: string) => `${variant}:${image}`),
      read: vi.fn(async (key: string) => records.get(key)), write: vi.fn() }
    const before = baseline(persistence, doc.id)
    await before.warmImageCache(kernel, doc)
    expect(persistence.read).toHaveBeenCalledTimes(2000)
    const oldRender = recordingRenderer(before.managedImageLoader(kernel), compiled)
    const adjust = { exposure: 0.2, contrast: -0.1, temperature: 0.15, tint: -0.05, highlights: 0.1, shadows: -0.1, color: 0.2 }
    for (const image of sceneIndex(compiled).images) {
      oldRender.renderer.imageFor(image, 0, false)
      oldRender.renderer.imageFor(image, 0, false, adjust)
    }
    persistence.key.mockClear(); persistence.read.mockClear()
    const cache = new DecodedImageCache(), context = { kernel, scope: 'canvas:1', settings: kernel.color_settings() }
    const hydration = new SceneImageHydration(cache, context, persistence, () => true)
    await hydration.hydrate(compiled)
    expect(persistence.read).toHaveBeenCalledTimes(4)
    const nextRender = recordingRenderer(managedSceneImageLoader(cache, () => context, persistence), compiled)
    for (const image of sceneIndex(compiled).images) {
      nextRender.renderer.imageFor(image, 0, false)
      nextRender.renderer.imageFor(image, 0, false, adjust)
    }
    expect(nextRender.uploaded).toEqual(oldRender.uploaded)
    for (const image of sceneIndex(compiled).images) {
      const linear = !!(compiled.floatCompositing || compiled.colorManagement)
      expect(records.get(`${linear ? 'linear' : 'byte'}:${image}`)!.data)
        .toEqual(linear ? kernel.image_linear(image) : kernel.image_rgba8(image))
    }
    expect(kernel.compile_gpu_packet(options)).toEqual(packetBefore)
    expect(kernel.render_rgba(options)).toEqual(pixelsBefore)
    expect(JSON.stringify(doc)).toBe(source)
  } finally { kernel.free() }
})

test('serialized queue binds exact per-lane color decoder across async render and priority yield', async () => {
  const first = fixture(4), second = fixture(4, true), a = new VectorEngine(), b = new VectorEngine()
  try {
    a.load_document(JSON.stringify(first.doc)); b.load_document(JSON.stringify(second.doc))
    const image = first.uris[1], expectedA = a.image_linear(image), expectedB = b.image_linear(image)
    expect(expectedA).not.toEqual(expectedB) // negative control: distinct working color spaces
    const cache = new DecodedImageCache(), persistence = { key: async () => undefined, read: async () => undefined, write() {} }
    const contexts = [a, b].map((kernel, i) => ({ kernel, scope: `lane:${i}`, settings: kernel.color_settings() }))
    let context = contexts[0]
    const load = managedSceneImageLoader(cache, () => context, persistence), queue = new RenderWorkQueue()
    const gate = deferred<void>(), outputs: Float32Array[] = []; let active = 0, maxActive = 0
    const render = async (index: number, wait = false) => {
      context = contexts[index]; maxActive = Math.max(maxActive, ++active)
      if (wait) await gate.promise
      outputs.push(load(image).pixels); active--
    }
    const canvas = queue.run(async () => { await render(0, true); await queue.yieldToHigherPriority(0); await render(0) })
    const interaction = queue.run(() => render(1), 1)
    expect(active).toBe(1); gate.resolve(); await Promise.all([canvas, interaction])
    expect(maxActive).toBe(1); expect(outputs).toEqual([expectedA, expectedB, expectedA])
  } finally { a.free(); b.free() }
})

test('compiled dependencies retain image masks, clips, blend sources and offscreen filter halos', async () => {
  const f = fixture(8), doc = f.doc
  doc.schemaVersion = 4
  doc.pages[0].children = ['image-0000', 'image-0001', 'image-0002', 'image-0003', 'image-0004', 'image-0005', 'image-0006']
  doc.pages[1].children = ['image-0007']
  doc.nodes['image-0001'].mask = true; doc.nodes['image-0001'].maskType = 'alpha'
  doc.nodes['image-0002'].blend = 'multiply'
  doc.nodes['image-0003'].transform[4] = 50
  doc.nodes['image-0003'].effects = [{ id: 'halo', kind: 'blur', radius: 12, visible: true,
    x: 0, y: 0, spread: 0, color: '#000000', opacity: 1, amount: 0 }]
  doc.nodes['image-0004'].effects = [{ id: 'backdrop', kind: 'background-blur', radius: 4, visible: true,
    x: 0, y: 0, spread: 0, color: '#000000', opacity: 1, amount: 0 }]
  doc.nodes['image-0005'].visible = false
  const frame = node('frame', 0, 0, 48, 16); frame.id = 'clip'; frame.clip = true; frame.fills = []
  frame.children = ['image-0006']; doc.nodes[frame.id] = frame
  doc.pages[0].children[6] = frame.id
  const kernel = new VectorEngine()
  try {
    kernel.load_document(JSON.stringify(doc))
    const options = JSON.stringify({ ...JSON.parse(f.options), gpuViewport: { x: 0, y: 0, w: 48, h: 16 } })
    const compiled = decodeScenePacket(kernel.compile_gpu_packet(options)), dependencies = sceneIndex(compiled).images
    expect(dependencies.has(f.uris[1])).toBe(true) // image mask
    expect(dependencies.has(f.uris[2])).toBe(true) // blended masked content
    expect(dependencies.has(f.uris[3])).toBe(true) // offscreen blur halo
    expect(dependencies.has(f.uris[4])).toBe(true) // backdrop source
    expect(dependencies.has(f.uris[6])).toBe(true) // clipped child
    expect(dependencies.has(f.uris[5])).toBe(false) // hidden
    expect(dependencies.has(f.uris[7])).toBe(false) // different page
    const s = setup(); await s.hydration.hydrate(compiled)
    expect(new Set(s.persistence.key.mock.calls.map(args => args[0]))).toEqual(dependencies)
  } finally { kernel.free() }
})


test('wrong-variant payloads consume the optional read budget before falling back', async () => {
  const s = setup({ limit: 64, read: async () => record(true) })
  await s.hydration.hydrate(scene([uri(1), uri(2), uri(3)]))
  expect(s.persistence.read).toHaveBeenCalledOnce()
  expect(s.cache.size).toBe(0)
  expect(s.load(uri(2), true).bytes).toEqual(record().data)
  expect(s.kernel.image_rgba8).toHaveBeenCalledOnce()
})

test('real mip opt-in preserves the exact requested byte and linear levels', () => {
  const rgba = new Uint8Array(16 * 16 * 4)
  for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 29) % 256
  const image = `data:image/png;base64,${Buffer.from(encode_png_rgba(16, 16, rgba)).toString('base64')}`
  const kernel = new VectorEngine()
  try {
    kernel.load_document(JSON.stringify(blank())); kernel.set_image_mips(true)
    const cache = new DecodedImageCache(), context = { kernel, scope: 'mips', settings: kernel.color_settings() }
    const persistence = { key: async () => undefined, read: async () => undefined, write: vi.fn() }
    const load = managedSceneImageLoader(cache, () => context, persistence)
    for (const level of [1, 2, 3]) {
      expect(load(image, true, level).bytes).toEqual(kernel.image_rgba8_at_level(image, level))
      expect(load(image, false, level).pixels).toEqual(kernel.image_linear_at_level(image, level))
      expect([load(image, true, level).width, load(image, true, level).height]).toEqual(JSON.parse(kernel.image_info_at_level(image, level)))
    }
    expect(persistence.write).not.toHaveBeenCalled()
  } finally { kernel.free() }
})

test('an unavailable kernel fingerprint disables further optional keys for this request only', async () => {
  const s = setup(); s.persistence.key.mockResolvedValue(undefined)
  await s.hydration.hydrate(scene([uri(1), uri(2)])); await s.hydration.hydrate(scene([uri(3)]))
  expect(s.persistence.key).toHaveBeenCalledOnce(); expect(s.persistence.read).not.toHaveBeenCalled()
  expect(s.load(uri(3), true).bytes).toEqual(record().data)
})

for (const floating of [undefined, false, true]) for (const managed of [false, true])
  test(`hydration representation matches production upload selection (float=${floating}, managed=${managed})`, async () => {
    const s = setup(), compiled = scene([uri(1)])
    if (floating === undefined) delete compiled.floatCompositing
    else compiled.floatCompositing = floating
    if (managed) compiled.colorManagement = defaultColorSettings()
    const linear = !!(floating || managed)
    await s.hydration.hydrate(compiled)
    const rendered = recordingRenderer(s.load, compiled)
    rendered.renderer.imageFor(uri(1), 0, false)
    expect(s.persistence.key.mock.calls.map(args => args[1])).toEqual([linear ? 'linear' : 'byte'])
    expect(s.kernel.image_info).not.toHaveBeenCalled()
    const data = record(linear).data
    expect(rendered.uploaded).toEqual([new Uint8Array(data.buffer, data.byteOffset, data.byteLength)])
  })

test('a decoded float payload larger than the real 64 MiB default cap bypasses optional residency', async () => {
  const width = 2049, height = 2049
  const oversized = { width, height, data: new Float32Array(width * height * 4) }
  expect(oversized.data.byteLength).toBeGreaterThan(64 * 1024 * 1024)
  const s = setup({ read: async () => oversized })
  await s.hydration.hydrate(scene([uri(1), uri(2)], true))
  expect(s.persistence.read).toHaveBeenCalledOnce(); expect(s.cache.size).toBe(0)
  expect(s.load(uri(1), false).pixels).toEqual(record(true).data)
  expect(s.kernel.image_linear).toHaveBeenCalledOnce()
})

test('an uploaded-source hint avoids disk work but cannot replace decoder or resource validation', async()=>{
 const s=setup(),compiled=scene([uri(1),uri(2)])
 await s.hydration.hydrate(compiled,()=>true,value=>value===uri(1))
 expect(s.persistence.read).toHaveBeenCalledTimes(1)
 expect(s.cache.get(s.context.scope,'b:'+uri(1))).toBeUndefined()
 // Eviction after the hint still reaches the unchanged authoritative decoder.
 expect(s.load(uri(1),true).bytes).toEqual(record().data)
 expect(s.kernel.image_rgba8).toHaveBeenCalledOnce()
 await s.hydration.hydrate(compiled,()=>true,()=>false)
 expect(s.cache.get(s.context.scope,'b:'+uri(1))?.data).toEqual(record().data)
})
