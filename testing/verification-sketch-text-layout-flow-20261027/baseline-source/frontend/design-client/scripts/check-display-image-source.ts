/** Actual-device screen-image candidate oracle. The independent reference is
 * the original paint -> normal-over-zero -> ordered quarter resolve, not the
 * fused helper. Native error is measured, never described as bit equivalence.
 * readSurface here is test instrumentation; production readback/export clears
 * scene.displayImageSource before preparation. This is not a latency test. */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runProof, sha256 } from './exact-prefix-proof-utils'

const scenePath = resolve(process.env.DESIGN_117_SCENE || '/tmp/futureox-fusion-117-scene.json')
const documentPath = resolve(process.env.DESIGN_117_DOCUMENT || '/tmp/futureox-fusion-117-document.json')
if (process.env.VITE_DESIGN_EXACT_IMAGE_X_TABLE === '0') throw Error('Actual upload range certificates must be enabled')
await runProof('futureox-display-image-source', [scenePath, documentPath], async proof => {
  const sceneBytes = await readFile(scenePath), documentBytes = await readFile(documentPath)
  const scene = JSON.parse(sceneBytes.toString()), document = JSON.parse(documentBytes.toString())
  const nodeId = '1AB99304-455A-4A9E-9473-8923A1330FA4', n = scene.nodes[nodeId]
  if (!n || n.children.length || n.fills.length !== 1 || n.fills[0].kind !== 'image' || n.fills[0].adjust ||
      n.fills[0].image !== document.nodes[nodeId].fills[0].image) throw Error('Unexpected actual117 saved image fixture')
  await proof.write('fixtures.json', { sceneSha256: sha256(sceneBytes), documentSha256: sha256(documentBytes),
    source: 'Actual uploaded linear pixels and native four-phase axes; synthetic dense/axes boundary programs',
    linearAbsoluteLimit: 2 ** -19, alphaAbsoluteLimit: 2 ** -20, sdrByteLimit: 1,
    scope: 'Bounded nonnegative opaque input; rejected input domains must retain exact raw output. Limits apply only to these fixtures.' })
  if (proof.prepareOnly) return { scope: 'Fixture inspection only; GPU comparison has not run' }
  return proof.browser(page => page.evaluate(async ({ scene, document, nodeId }) => {
    const { WebGpuDriver } = await import('/src/kernel/gpu/webgpu.ts')
    const { parameters } = await import('/src/kernel/gpu/types.ts')
    const { initializeKernelModule } = await import('/src/kernel/module.ts')
    const { VectorEngine, image_sampling_axes_placed } = await import('/src/generated/design-kernel/design_kernel.js')
    type Texture = import('/src/kernel/gpu/types.ts').Texture
    type Rect = { x: number; y: number; w: number; h: number }
    type Fixture = { name: string; iw: number; ih: number; pixels: Float32Array; axes: boolean; fields: Float32Array[];
      full: Rect; windows: { name: string; r: Rect }[]; admitted: boolean; holes?: boolean; golden?: Record<string, string> }
    const digest = async (v: Float32Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Float32Array(v).buffer)))
      .map(v => v.toString(16).padStart(2, '0')).join('')
    const byte = (v: number) => Math.round(Math.min(1, Math.max(0, v <= .0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - .055)) * 255)
    const fixtures: Fixture[] = []
    for (const [name, kind, axes, holes] of [
      ['bounded-dense', 0, false, false], ['bounded-axes-endpoints-ku36-kv35', 0, true, false],
      ['contain-margins-and-binary-holes', 0, true, true], ['subnormal-and-negative-zero', 1, true, false],
      ['reject-negative-RGB', 2, true, false], ['reject-HDR-above-bound', 3, false, false],
      ['reject-fractional-alpha', 4, true, false], ['reject-zero-alpha-HDR', 5, true, false],
    ] as const) {
      const iw = 19, ih = 17, w = 73, h = 47, full = { x: -19, y: 23, w, h }, span = Math.max(w, h)
      const pixels = new Float32Array(iw * ih * 4), raw = new Uint32Array(pixels.buffer)
      for (let p = 0; p < iw * ih; p++) for (let c = 0; c < 4; c++) {
        const i = p * 4 + c
        pixels[i] = c === 3 ? 1 : ((p * 37 + c * 19) % 509) / 256
        if (kind === 1 && c < 3) raw[i] = [0, 0x80000000, 1, 0x007fffff, 0x00800001][(p + c) % 5]
        if (kind === 2 && c < 3 && p % 3 === 0) pixels[i] *= -1
        if (kind === 3 && c < 3) pixels[i] = (p + c) % 3 ? 4 : 2
        if (kind === 4 && c === 3) pixels[i] = p % 2 ? .5 : 1
        if (kind === 5) pixels[i] = c === 3 ? 0 : [4, -3, .125][c]
      }
      const fields = Array.from({ length: 4 }, (_, sample) => {
        const values = new Float32Array(axes ? span * 8 : w * h * 4)
        const kx = [0, 1, 2 ** -36, .125, .5, 1 - 2 ** -24], ky = [1, 0, 2 ** -35, .25, .75, 1 - 2 ** -24]
        if (axes) {
          for (let x = 0; x < w; x++) values.set([(x * 3 + sample) % (iw + 2) - 1, kx[(x + sample) % kx.length], holes && x % 11 === 0 ? 0 : 1, -1], x * 4)
          for (let y = 0; y < h; y++) values.set([(y * 5 + sample) % (ih + 2) - 1, ky[(y + sample) % ky.length], holes && y % 9 === 0 ? 0 : 1, -1], (span + y) * 4)
        } else for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) values.set([
          (x + y + sample) % (iw + 2) - 1, (y + sample) % (ih + 2) - 1, kx[(x + sample) % kx.length], ky[(y + sample) % ky.length]], (y * w + x) * 4)
        return values
      })
      fixtures.push({ name, iw, ih, pixels, axes, fields, full, admitted: kind < 2, holes, windows: [{ name: 'full', r: full }] })
    }
    await initializeKernelModule()
    const engine = new VectorEngine(); engine.load_document(JSON.stringify(document))
    try {
      const n = scene.nodes[nodeId], p = n.fills[0], [iw, ih] = JSON.parse(engine.image_info(p.image))
      const pixels = engine.image_linear(p.image), full = { x: -1228, y: -1228, w: 3484, h: 3484 }
      const paint = JSON.stringify({ kind: 'image', color: p.color, fit: p.fit, transform: p.transform, tile: p.tile })
      const fields = Array.from({ length: 4 }, (_, sample) => image_sampling_axes_placed(JSON.stringify(full),
        new Float64Array(n.matrix), new Float64Array(n.size), new Uint32Array([iw, ih]), paint, sample, 0, new Int32Array([0, 0])))
      if (fields.some(f => f.length !== 3484 * 8)) throw Error('Actual117 native axes changed shape')
      fixtures.push({ name: 'actual117', iw, ih, pixels, axes: true, fields, full, admitted: true,
        windows: [0, 1713, 3426].map((y, i) => ({ name: ['top', 'middle', 'bottom'][i], r: { ...full, y: full.y + y, h: 58 } })),
        golden: { top: '21bc655cf873f2795db86e32096760d2c468eb797bae086a705b37c9a4af473e',
          middle: '635d294a60a34f5d73180a291804194a169bfd7c730740b5b7e50962bb21eb50',
          bottom: 'c5fe3b0e1149665080be1e58d5206e0c9225949f964a4dcd9e0d630d3d882d67' } })
    } finally { engine.free() }
    const driver = await WebGpuDriver.create(true, false, true, true, false), device = (driver as any).device
    const baseScene = { nodes: { image: { fill: { count: 0 }, fills: [{ kind: 'image', blend: 'normal' }], strokes: [], effects: [], blend: 'normal' } } } as any
    const records: any[] = []; let peakTextureBytes = 0, components = 0, nativePasses = 0
    try {
      await driver.prepareScene({ ...baseScene, displayImageSource: true })
      for (const f of fixtures) for (const { name, r } of f.windows) {
        driver.begin(new Float32Array(0)); const owned = new Set<Texture>()
        const own = (t: Texture) => { owned.add(t); return t }
        const drop = (t?: Texture) => { if (t && owned.delete(t)) driver.destroy(t) }
        try {
          const image = own(driver.uploadLinear(f.pixels, f.iw, f.ih)), ir = { x: 0, y: 0, w: f.iw, h: f.ih }
          if (driver.usesDisplayImageSource(image) !== f.admitted) throw Error(`Unexpected native admission: ${f.name}`)
          const empty = own(driver.create(r.w, r.h)); driver.clear(empty)
          let oldResolved: Texture | undefined, newResolved: Texture | undefined
          for (let sample = 0; sample < 4; sample++) {
            const mask = own(driver.createBinaryCoverage(r.w, r.h)), coverage = new Uint8Array(r.w * r.h * 4)
            for (let i = 0; i < coverage.length; i++) coverage[i] = f.holes && (Math.floor(i / 4) + sample) % 7 === 0 ? 0 : 255
            device.queue.writeTexture({ texture: mask.resource }, coverage, { bytesPerRow: r.w * 4 }, [r.w, r.h])
            const field = own(driver.uploadParameters(f.fields[sample], f.axes ? Math.max(f.full.w, f.full.h) : f.full.w, f.axes ? 2 : f.full.h))
            const paint = own(driver.create(r.w, r.h)), over = own(driver.create(r.w, r.h))
            const nextOld = own(driver.create(r.w, r.h)), nextNew = own(driver.create(r.w, r.h))
            const u = parameters(r, r, ir, r); u[16] = 2; u[28] = 3; u[32] = 1; u[241] = 1; u.set([f.full.x, f.full.y], 204)
            driver.pass(paint, u, [mask, image, mask, field])
            const normal = parameters(r, r, r); normal.set([3, 0, 1, 0], 16); driver.pass(over, normal, [paint, empty])
            const resolve = parameters(r, r, r); resolve[16] = 48; resolve[17] = sample
            driver.pass(nextOld, resolve, [over, oldResolved || empty])
            const native = u.slice(); native[16] = 51; native[17] = sample
            driver.pass(nextNew, native, [mask, image, newResolved || empty, field])
            if (nextNew.finitePixels || nextNew.opaqueAlpha || driver.imageTableRange(nextNew)) throw Error('Native output incorrectly received an exact certificate')
            const a = await driver.readSurface(nextOld), b = await driver.readSurface(nextNew)
            const ab = new Uint32Array(a.buffer), bb = new Uint32Array(b.buffer)
            let maxAbsolute = 0, maxAlpha = 0, maxSdrByte = 0, sumSquared = 0, rawDifferences = 0, zeroAlphaRgb = 0
            for (let i = 0; i < a.length; i++) {
              if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) throw Error(`Nonfinite result: ${f.name}`)
              const error = Math.abs(a[i] - b[i]); maxAbsolute = Math.max(maxAbsolute, error); sumSquared += error * error
              if (i % 4 === 3) { maxAlpha = Math.max(maxAlpha, error); if (a[i] === 0 && (b[i - 3] !== 0 || b[i - 2] !== 0 || b[i - 1] !== 0)) zeroAlphaRgb++ }
              else maxSdrByte = Math.max(maxSdrByte, Math.abs(byte(a[i]) - byte(b[i])))
              if (ab[i] !== bb[i]) rawDifferences++
            }
            const referenceSha256 = await digest(a), candidateSha256 = await digest(b)
            if (sample === 3 && f.golden && referenceSha256 !== f.golden[name]) throw Error(`Existing exact117 reference hash changed: ${name}: ${referenceSha256}`)
            if (maxAbsolute > 2 ** -19 || maxAlpha > 2 ** -20 || maxSdrByte > 1 || zeroAlphaRgb || !f.admitted && rawDifferences)
              throw Error(`Screen source boundary failed: ${JSON.stringify({ name: f.name, window: name, sample, maxAbsolute, maxAlpha, maxSdrByte, zeroAlphaRgb, rawDifferences })}`)
            records.push({ name: f.name, window: name, sample, admitted: f.admitted, components: a.length, maxAbsolute, maxAlpha, maxSdrByte,
              rootMeanSquare: Math.sqrt(sumSquared / a.length), rawDifferences, referenceSha256, candidateSha256 })
            components += a.length; peakTextureBytes = Math.max(peakTextureBytes, driver.stats().textureBytes)
            drop(paint); drop(over); drop(mask); drop(field); drop(oldResolved); drop(newResolved)
            oldResolved = nextOld; newResolved = nextNew
          }
          const expectedPasses = f.admitted ? 4 : 0
          if (driver.displayImageSourcePasses !== expectedPasses) throw Error(`Candidate was not actually used: ${f.name}`)
          nativePasses += driver.displayImageSourcePasses
          await driver.prepareScene({ ...baseScene, displayImageSource: false })
          if (driver.usesDisplayImageSource(image) || (driver as any).device !== device) throw Error('Tier switch retained native intent or replaced device')
          await driver.finish(newResolved!, r, r.w, r.h, false, undefined, false)
          await driver.prepareScene({ ...baseScene, displayImageSource: true })
        } finally { for (const t of owned) driver.destroy(t) }
      }
      if (peakTextureBytes >= 256 * 1024 * 1024) throw Error('Proof texture allocation exceeded the production ledger')
      return { adapter: driver.stats().adapter, cases: fixtures.length, samples: records.length, components, nativePasses, peakTextureBytes,
        records, scope: 'Actual GPU numeric screen-candidate error and rejected-domain raw parity; no performance, screenshot or export acceptance claim' }
    } finally { driver.dispose() }
  }, { scene, document, nodeId }))
})
