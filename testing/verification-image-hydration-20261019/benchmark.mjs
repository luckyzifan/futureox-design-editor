// CPU-only ABBA probe of the exact old/new optional hydration boundary.
// No browser, GPU, sockets or real IndexedDB latency is represented.
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
const root = new URL('../../', import.meta.url), client = new URL('frontend/design-client/', root)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const base = new URL(specifier, context.parentURL)
      if (!/\.[cm]?[jt]sx?$/.test(base.pathname)) for (const ext of ['.ts', '.js']) {
        const candidate = new URL(base.href); candidate.pathname += ext
        if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true }
      }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith('file:') && url.endsWith('.ts')) return { format: 'module', shortCircuit: true,
      source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }).replaceAll('import.meta.env', '({ DEV: false })') }
    return next(url, context)
  },
})
const { default: initialize, VectorEngine, encode_png_rgba } = await import(new URL('src/generated/design-kernel/design_kernel.js', client))
const { blank, node, paint } = await import(new URL('src/model.ts', client))
const { DecodedImageCache } = await import(new URL('src/kernel/decoded-image-cache.ts', client))
const { SceneImageHydration, managedSceneImageLoader } = await import(new URL('src/kernel/scene-image-hydration.ts', client))
const { decodeScenePacket } = await import(new URL('src/kernel/gpu/scene-packet.ts', client))
const { sceneIndex } = await import(new URL('src/kernel/gpu/scene-index.ts', client))
const { imageCacheKey } = await import(new URL('src/kernel/image-mip-cache.ts', client))
const wasm = new Uint8Array(readFileSync(new URL('public/kernel/design_kernel_bg.wasm', client)))
await initialize({ module_or_path: wasm })
const previousFetch = globalThis.fetch
// The production key function hashes the exact shipped WASM; no network fetch.
globalThis.fetch = async () => ({ arrayBuffer: async () => wasm.slice().buffer })
const baseSource = readFileSync(new URL('baseline-image-cache.txt', import.meta.url), 'utf8')
const baseManifest = JSON.parse(readFileSync(new URL('baseline.json', import.meta.url), 'utf8'))
assert.equal(hash(baseSource), baseManifest.excerptSha256)
const baseFactory = new Function('DecodedImageCache', 'imageCacheKey', 'readCachedImage', 'writeCachedImage', 'loadedDocumentId',
  stripTypeScriptTypes(baseSource, { mode: 'strip' }) + '\nreturn { warmImageCache, managedImageLoader };')
const count = 1000, document = blank('Hydration ABBA source fixture')
document.id = 'hydration-abba'; document.pages[0].id = 'visible'; document.pages.push({ id: 'other', name: 'Other images', background: '#ffffff', children: [] })
const images = []
for (let i = 0; i < count; i++) {
  const image = `data:image/png;base64,${Buffer.from(encode_png_rgba(1, 1, new Uint8Array([i % 256, Math.floor(i / 256), i * 37 % 256, 127 + i % 129]))).toString('base64')}`
  const value = node('rectangle', i % 4 * 12, 0, 12, 12); value.id = `image-${String(i).padStart(4, '0')}`
  value.fills = [{ ...paint('#ffffff'), id: `paint-${i}`, kind: 'image', image }]
  document.nodes[value.id] = value; document.pages[i < 4 ? 0 : 1].children.push(value.id); images.push(image)
}
const kernel = new VectorEngine(), source = JSON.stringify(document)
try {
  kernel.load_document(source)
  const options = JSON.stringify({ pageId: 'visible', width: 48, height: 16, view: { x: 0, y: 0, zoom: 1 }, transparent: true, rasterProfile: 'analytic' })
  const packet = kernel.compile_gpu_packet(options), scene = decodeScenePacket(packet), pixels = kernel.render_rgba(options)
  const dependencies = sceneIndex(scene).images
  assert.equal(dependencies.size, 4)
  const records = new Map()
  for (const image of images) for (const variant of ['byte', 'linear']) records.set(await imageCacheKey(image, variant, kernel.color_settings()),
    { width: 1, height: 1, data: variant === 'byte' ? kernel.image_rgba8(image) : kernel.image_linear(image) })
  const rows = []
  for (let cycle = 0; cycle < 6; cycle++) for (const kind of ['baseline', 'candidate', 'candidate', 'baseline']) {
    const counters = { keys: 0, reads: 0, payloadBytes: 0, activeReads: 0, peakActiveReads: 0, decoderCalls: 0 }
    const persistence = {
      key: (...args) => { counters.keys++; return imageCacheKey(...args) },
      read: async key => {
        counters.reads++; counters.peakActiveReads = Math.max(counters.peakActiveReads, ++counters.activeReads)
        const record = structuredClone(records.get(key)); counters.payloadBytes += record?.data.buffer.byteLength || 0
        await Promise.resolve(); counters.activeReads--; return record
      },
      write() {},
    }
    const decoder = Object.fromEntries(['image_info', 'image_info_at_level', 'image_rgba8', 'image_rgba8_at_level', 'image_linear', 'image_linear_at_level']
      .map(method => [method, (...args) => { counters.decoderCalls++; return kernel[method](...args) }]))
    decoder.color_settings = () => kernel.color_settings()
    const cache = new DecodedImageCache(), context = { kernel: decoder, settings: kernel.color_settings(), scope: 'canvas:1' }
    const candidate = new SceneImageHydration(cache, context, persistence, () => true)
    const baseline = baseFactory(DecodedImageCache, persistence.key, persistence.read, persistence.write, document.id)
    const start = performance.now()
    if (kind === 'baseline') await baseline.warmImageCache(decoder, document)
    else await candidate.hydrate(scene)
    const hydrationMs = performance.now() - start
    const loader = kind === 'baseline' ? baseline.managedImageLoader(decoder) : managedSceneImageLoader(cache, () => context, persistence)
    const linear = !!(scene.floatCompositing || scene.colorManagement)
    for (const image of dependencies) {
      const result = loader(image, !linear)
      assert.deepEqual(result.bytes ?? result.pixels, linear ? kernel.image_linear(image) : kernel.image_rgba8(image))
    }
    assert.equal(counters.decoderCalls, 0); assert.equal(counters.activeReads, 0); assert.equal(counters.peakActiveReads, 1)
    assert.equal(counters.reads, kind === 'baseline' ? 2000 : 4)
    assert.equal(JSON.stringify(document), source); assert.deepEqual(kernel.compile_gpu_packet(options), packet); assert.deepEqual(kernel.render_rgba(options), pixels)
    if (cycle) rows.push({ cycle, kind, hydrationMs, ...counters })
  }
  const summary = Object.fromEntries(['baseline', 'candidate'].map(kind => {
    const values = rows.filter(row => row.kind === kind).map(row => row.hydrationMs).sort((a, b) => a - b)
    return [kind, { samples: values.length, medianMs: (values[4] + values[5]) / 2, p95Ms: values.at(-1), minMs: values[0], maxMs: values.at(-1) }]
  }))
  const paths = ['frontend/design-client/src/kernel/render-worker.ts', 'frontend/design-client/src/kernel/scene-image-hydration.ts',
    'frontend/design-client/src/kernel/decoded-image-cache.ts', 'frontend/design-client/src/kernel/image-mip-cache.ts',
    'frontend/design-client/src/kernel/gpu/scene-index.ts', 'testing/verification-image-hydration-20261019/benchmark.mjs']
  console.log(JSON.stringify({ schemaVersion: 1, note: 'CPU hydration-boundary proxy only. Production SHA keys and cache algorithms; in-memory structured-clone persistence double. Excludes disk/IndexedDB, GPU rendering and display/FPS. First ABBA cycle warmup, then 10 samples per implementation. No time-ratio acceptance threshold.',
    node: process.version, fixture: { documentImages: 1000, sceneDependencies: 4, variant: scene.floatCompositing || scene.colorManagement ? 'linear' : 'byte', documentSha256: hash(source), cpuPixelsSha256: hash(pixels), packetSha256: hash(packet) },
    wasmSha256: hash(wasm), sources: Object.fromEntries(paths.map(path => [path, hash(readFileSync(new URL(path, root)))])),
    baseline: baseManifest, summary, rows }, null, 2))
} finally { kernel.free(); globalThis.fetch = previousFetch; hooks.deregister() }
