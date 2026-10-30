/** Real WASM -> production WebGPU oracle for the sequential screen route.
 * Both renderers receive render(readback=false, present=true). A finish-only
 * observer reads the actual raw target before ordinary presentation; that
 * explicit proof readback is instrumentation, never a product-path claim.
 * No timings here are interaction or physical-display performance evidence. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { initSync, VectorEngine, encode_png_rgba } from '../src/generated/design-kernel/design_kernel.js'
import { planSequentialDisplay } from '../src/kernel/gpu/sequential-display-plan'
import { certifyExactImageRange } from '../src/kernel/gpu/exact-image-x-table'
import type { GpuScene, Rect } from '../src/kernel/gpu/types'
import { validGpuWorkingBudgetMiB } from '../src/kernel/render-policy'
import { project, runProof, sha256 } from './exact-prefix-proof-utils'

if (process.env.VITE_DESIGN_SEQUENTIAL_DISPLAY !== '1') throw Error('Run with VITE_DESIGN_SEQUENTIAL_DISPLAY=1')
const requestedBudget = process.env.DESIGN_TEST_GPU_WORKING_BUDGET_MIB
const gpuWorkingBudgetMiB = requestedBudget === undefined ? undefined : Number(requestedBudget)
if (requestedBudget !== undefined && (!/^[1-9][0-9]*$/.test(requestedBudget) || !validGpuWorkingBudgetMiB(gpuWorkingBudgetMiB)))
  throw Error('DESIGN_TEST_GPU_WORKING_BUDGET_MIB must be an integer from 256 to 4096')
type DocumentFixture = {
  schemaVersion: number; id: string; name: string
  colorManagement: { documentSpace: 'srgb-linear'; referenceWhiteNits: number; peakLuminanceNits: number }
  pages: { id: string; name: string; background: string; children: string[] }[]
  nodes: Record<string, any>
}
type Fixture = { name: string; document: DocumentFixture; options: Record<string, unknown>; admitted: boolean }
function documentFixture(name: string, colors: string[]): DocumentFixture {
  const shape = (id: string, kind: string, x: number, y: number, width: number, height: number, color: string) => ({
    id, kind, width, height, transform: [1, 0, 0, 1, x, y], opacity: 1, blend: 'normal', visible: true,
    fills: [{ kind: 'solid', color, opacity: .875, blend: 'normal', visible: true }],
    children: [], strokes: [], effects: [], clip: false, mask: false,
  })
  const root = { ...shape('root', 'group', 0, 0, 600, 1400, colors[0]), fills: [], opacity: .875,
    children: ['under', 'nest', 'ring', 'flipped', 'round', 'culled'] }
  const nest = { ...shape('nest', 'group', 31.125, 42.375, 330, 1180, colors[0]), fills: [], opacity: .625,
    children: ['first', 'second'] }
  const ring = shape('ring', 'vector', 47.375, 87.125, 151, 219, colors[2])
  const points = [[0, 0], [151, 0], [151, 219], [0, 219], [31, 43], [120, 43], [120, 176], [31, 176]]
  Object.assign(ring, { network: { fillRule: 'evenodd',
    vertices: points.map(([x, y], i) => ({ id: `v${i}`, x, y })),
    edges: Array.from({ length: 8 }, (_, i) => ({ id: `e${i}`, from: `v${i}`, to: `v${i < 4 ? (i + 1) % 4 : 4 + (i - 3) % 4}` })),
  } })
  const flipped = shape('flipped', 'rectangle', 400.375, 23.25, 190, 1013, colors[1])
  flipped.transform = [-1, .125, .0625, 1, 400.375, 23.25]
  const round = { ...shape('round', 'rectangle', 143.125, 486.375, 217, 231, colors[2]), radii: [13, 7, 19, 3] }
  const first = { ...shape('first', 'rectangle', 5.375, 8.125, 271, 979, colors[1]), opacity: .75 }
  const second = shape('second', 'ellipse', 57.125, 142.375, 238, 751, colors[2])
  second.fills.push({ ...second.fills[0], color: colors[0], opacity: .3125 })
  return { schemaVersion: 5, id: `sequential-${name}`, name,
    colorManagement: { documentSpace: 'srgb-linear', referenceWhiteNits: 203, peakLuminanceNits: 1000 },
    pages: [{ id: 'p', name: 'p', background: '#172a3c', children: ['root'] }],
    nodes: { root, nest, under: shape('under', 'rectangle', -20.125, -30.375, 650, 1460, colors[0]),
      first, second, ring, flipped, round, culled: shape('culled', 'rectangle', 100_000, 100_000, 17, 19, colors[0]) } }
}
const ordinaryColors = ['#347fc4', 'color(srgb-linear 1.75 -0.25 0.375 / 0.625)', '#d45687']
const boundaryColors = ['color(srgb-linear 65504 -32752 0 / 0.75)',
  'color(srgb-linear -65504 65504 1e-40 / 0.5)', 'color(srgb-linear 1e-38 -1e-38 0.0000000000000000000000000000000000000001 / 0.875)']
const fixtures: Fixture[] = []
for (const [name, width, height, x, y, zoom, transparent, colors, capture] of [
  ['correlated-fractional', 239, 193, .125, .375, 1, true, ordinaryColors, { x: 0, y: 0, w: 239, h: 193 }],
  ['correlated-zoomed', 281, 231, -17.375, 11.125, 1.375, false, ordinaryColors, { x: 0, y: 0, w: 281, h: 231 }],
  ['negative-global-roi', 201, 163, .375, -.125, 1.125, true, ordinaryColors, { x: -13, y: 29, w: 201, h: 163 }],
  ['three-bands-odd-size', 385, 1259, .125, .375, 1, false, ordinaryColors, { x: 0, y: 0, w: 385, h: 1259 }],
  ['signed-authored-HDR-limits', 239, 193, .125, .375, 1, true, boundaryColors, { x: 0, y: 0, w: 239, h: 193 }],
  ['signed-authored-HDR-three-bands', 321, 1109, -.375, .125, 1.125, true, boundaryColors, { x: -7, y: 11, w: 321, h: 1109 }],
] as const) fixtures.push({ name, document: documentFixture(name, [...colors]), admitted: true,
  options: { pageId: 'p', width, height, view: { x, y, zoom }, transparent, grid: false,
    rasterProfile: 'figmaSubpixel', captureViewport: capture } })
for (const kind of ['clip', 'stroke', 'gradient', 'blur', 'backdrop', 'multiply'] as const) {
  const name = `reject-${kind}`, document = documentFixture(name, ordinaryColors), n = document.nodes.first
  if (kind === 'clip') document.nodes.nest.clip = true
  if (kind === 'stroke') n.strokes = [{ width: 3.25, align: 'center', paint: { kind: 'solid', color: '#3b8a27' } }]
  if (kind === 'gradient') n.fills = [{ kind: 'linear', color: '#347fc4', angle: 37,
    stops: [{ offset: 0, color: '#347fc4' }, { offset: 1, color: '#d45687' }] }]
  if (kind === 'blur' || kind === 'backdrop') n.effects = [{ kind: kind === 'blur' ? 'blur' : 'background-blur',
    visible: true, radius: 2.25, x: 0, y: 0, spread: 0, color: '#000000', opacity: 1, amount: 0 }]
  if (kind === 'multiply') n.blend = 'multiply'
  fixtures.push({ name, document, admitted: false, options: { pageId: 'p', width: 201, height: 163,
    view: { x: .125, y: .375, zoom: 1 }, transparent: true, grid: false, rasterProfile: 'figmaSubpixel',
    captureViewport: { x: 0, y: 0, w: 201, h: 163 } } })
}

await runProof('futureox-sequential-display', [], async proof => {
  const wasm = await readFile(join(project, 'public/kernel/design_kernel_bg.wasm')); initSync({ module: wasm })
  // Encode real PNG assets with the actual kernel, then decode them through
  // image_info/image_linear below and again in the browser. No hand-written
  // linear pixels or texture certificates are injected into either renderer.
  for (const [name, fit, width, height, transparentSource] of [
    ['image-fractional-cover-boundary', 'cover', 239, 193, false],
    ['image-contain-negative-roi-three-bands', 'contain', 385, 1259, false],
    ['reject-unproved-translucent-image', 'cover', 239, 193, true],
  ] as const) {
    const imageWidth = 19, imageHeight = 17, rgba = new Uint8Array(imageWidth * imageHeight * 4)
    for (let i = 0; i < imageWidth * imageHeight; i++) rgba.set([
      (i * 37 + 19) % 256, (i * 17 + 53) % 256, (i * 71 + 11) % 256,
      transparentSource && i % 3 === 0 ? 127 : 255,
    ], i * 4)
    const uri = 'data:image/png;base64,' + Buffer.from(encode_png_rgba(imageWidth, imageHeight, rgba)).toString('base64')
    const document = documentFixture(name, ordinaryColors)
    document.nodes.image = { ...document.nodes.first, id: 'image', width: 357.25, height: 1137.5,
      transform: [1, .0625, -.03125, 1, -9.375, 17.125], children: [], opacity: .8125,
      fills: [{ kind: 'image', image: uri, fit, color: '#ffffff', angle: 0, stops: [],
        visible: true, blend: 'normal', opacity: .6875 }] }
    document.nodes.root.children.splice(1, 0, 'image')
    fixtures.push({ name, document, admitted: !transparentSource, options: { pageId: 'p', width, height,
      view: { x: .125, y: .375, zoom: 1.125 }, transparent: true, grid: false, rasterProfile: 'figmaSubpixel',
      captureViewport: { x: fit === 'contain' ? -13 : 0, y: fit === 'contain' ? 29 : 0, w: width, h: height } } })
  }
  const prepared = fixtures.map(fixture => {
    const kernel = new VectorEngine()
    try {
      kernel.load_document(JSON.stringify(fixture.document))
      const native = kernel.compile_gpu(JSON.stringify(fixture.options)), scene = JSON.parse(native) as GpuScene
      const output = scene.output ?? { x: 0, y: 0, w: scene.width, h: scene.height }
      if (!scene.floatCompositing || !scene.coherentSamples || scene.resolve || scene.presentation)
        throw Error(`${fixture.name}: expected native managed coherent display scene`)
      const preparedImageIds = new Set<string>(), imageSources: unknown[] = []
      for (const node of Object.values(scene.nodes)) {
        const paints = node.fills.filter(paint => paint.visible && paint.kind === 'image')
        if (!paints.length || node.effects.length) continue
        let admitted = true
        for (const paint of paints) {
          if (!paint.image) throw Error('PNG fixture lost its native image URI')
          const [width, height] = JSON.parse(kernel.image_info(paint.image)) as [number, number]
          const pixels = kernel.image_linear(paint.image), range = certifyExactImageRange(pixels)
          const sourceAdmitted = !!range && range.opaqueAlpha === true && range.nonnegativeRgb === true &&
            range.maximum.every(value => Number.isInteger(value) && value >= 1 && value <= 127)
          admitted &&= sourceAdmitted
          imageSources.push({ nodeId: node.id, width, height, sourceAdmitted,
            pngSha256: sha256(Buffer.from(paint.image.split(',')[1], 'base64')),
            decodedSha256: sha256(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength)) })
        }
        if (admitted) preparedImageIds.add(node.id)
      }
      const plan = planSequentialDisplay(scene, output, { managed: true, hdr: false, present: true, readback: false,
        allowCulledNodes: true, preparedImageIds })
      if (!!plan !== fixture.admitted) throw Error(`${fixture.name}: native scene admission did not match fixture`)
      return { ...fixture, nativeSceneSha256: sha256(native), documentSha256: sha256(JSON.stringify(fixture.document)),
        output, imageSources, preparedImageIds: [...preparedImageIds], nativeView: scene.view,
        nativeMatrices: Object.fromEntries(Object.entries(scene.nodes).map(([id, node]) => [id, node.matrix])),
        compiledNodes: Object.keys(scene.nodes).length,
        culledChildren: Object.values(scene.nodes).reduce((sum, n) => sum + n.children.filter(id => !Object.hasOwn(scene.nodes, id)).length, 0),
        plan: plan ? { maxDepth: plan.maxDepth, estimatedPeakBytes: plan.estimatedPeakBytes,
          regions: Object.fromEntries(plan.regions), expectedBands: Math.ceil(output.h / Math.min(512, Math.floor(524_288 / output.w))) } : null }
    } finally { kernel.free() }
  })
  const manifest = { cases: prepared.length, admitted: prepared.filter(f => f.admitted).length,
    gpuWorkingBudgetMiB: gpuWorkingBudgetMiB ?? null,
    wasmSha256: sha256(wasm), flag: 'VITE_DESIGN_SEQUENTIAL_DISPLAY=1',
    gate: 'Every raw RGBA32F word must match the independent original four-plane renderer. All outputs must be finite. Accepted cases must execute the actual sequential counter; rejected cases must throw UNSUPPORTED then successfully use the original path on the same renderer. Two accepted real-PNG cases cancel after the first actual band copy, finish no frame, release all image pins, then recover on the same renderer with original raw parity.',
    scope: 'Native managed solid and privately admitted real-PNG scenes, full painter order and four original phases; legal authored signed/HDR color limits, not arbitrary injected GPU float values. CPU decode range metadata prepares fixtures but is not a GPU upload certificate. Proof-only target reads deliberately fence and cannot measure interaction latency.' }
  await proof.write('fixtures.json', { ...manifest, fixtures: prepared })
  if (proof.prepareOnly) return { ...manifest, scope: 'Actual WASM compilation and admission only; no GPU has run.' }
  return proof.browser(page => page.evaluate(async ({ fixtures, manifest }) => {
    const { initializeKernelModule } = await import('/src/kernel/module.ts')
    const { VectorEngine } = await import('/src/generated/design-kernel/design_kernel.js')
    const { createGpu } = await import('/src/kernel/gpu/factory.ts')
    type GpuScene = import('/src/kernel/gpu/types.ts').GpuScene
    type Rect = import('/src/kernel/gpu/types.ts').Rect
    type WebGpuDriver = import('/src/kernel/gpu/webgpu.ts').WebGpuDriver
    const digest = async (value: string | Float32Array) => {
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(new Float32Array(value).buffer)
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(v => v.toString(16).padStart(2, '0')).join('')
    }
    const crop = (values: Float32Array, source: Rect, target: Rect) => {
      if (![source.x, source.y, source.w, source.h, target.x, target.y, target.w, target.h].every(Number.isSafeInteger) ||
          target.x < source.x || target.y < source.y || target.x + target.w > source.x + source.w ||
          target.y + target.h > source.y + source.h || values.length !== source.w * source.h * 4)
        throw Error('Observed target did not contain the exact requested native ROI')
      const result = new Float32Array(target.w * target.h * 4), input = new Uint32Array(values.buffer, values.byteOffset, values.length), bits = new Uint32Array(result.buffer)
      for (let row = 0; row < target.h; row++) {
        const start = ((target.y - source.y + row) * source.w + target.x - source.x) * 4
        bits.set(input.subarray(start, start + target.w * 4), row * target.w * 4)
      }
      return result
    }
    const compare = async (name: string, a: Float32Array, b: Float32Array) => {
      if (a.length !== b.length) throw Error(`${name}: missing raw components`)
      const aa = new Uint32Array(a.buffer, a.byteOffset, a.length), bb = new Uint32Array(b.buffer, b.byteOffset, b.length)
      let rawDifferences = 0, nonfinite = 0; const examples: unknown[] = []
      for (let i = 0; i < aa.length; i++) {
        if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) nonfinite++
        if (aa[i] !== bb[i]) { rawDifferences++; if (examples.length < 12) examples.push({ component: i, reference: aa[i], actual: bb[i] }) }
      }
      const record = { components: a.length, rawDifferences, nonfinite, examples,
        referenceSha256: await digest(a), actualSha256: await digest(b) }
      if (rawDifferences || nonfinite) throw Error(`${name}: raw target gate failed: ${JSON.stringify(record)}`)
      return record
    }
    await initializeKernelModule()
    const records: unknown[] = [], cancellationRecords: {
      name: string; bandCopiesBeforeCancel: number; finishObservationsAfterCancel: number;
      sequentialFramesAfterCancel: number; imagePinsAfterCancel: number; recoveredRawDifferences?: number;
    }[] = []
    let components = 0, proofReadbackBytes = 0, sequentialFrames = 0
    for (const f of fixtures) {
      const kernel = new VectorEngine(); let reference: Float32Array | undefined
      try {
        kernel.load_document(JSON.stringify(f.document))
        const native = kernel.compile_gpu(JSON.stringify(f.options))
        if (await digest(native) !== f.nativeSceneSha256) throw Error(`${f.name}: browser/native preparation hash changed`)
        const original = JSON.parse(native) as GpuScene
        const imageCache = new Map<string, { width: number; height: number; pixels: Float32Array; bytes?: Uint8Array }>()
        const loader = (uri: string, byte = false, level = 0) => {
          if (level !== 0) throw Error('The sequential proof must not silently enable image mips')
          const key = JSON.stringify([uri, byte])
          let image = imageCache.get(key)
          if (!image) {
            const [width, height] = JSON.parse(kernel.image_info(uri)) as [number, number]
            image = { width, height, pixels: kernel.image_linear(uri), ...(byte ? { bytes: kernel.image_rgba8(uri) } : {}) }
            imageCache.set(key, image)
          }
          return image
        }
        for (const source of f.imageSources as { nodeId: string; decodedSha256: string }[]) {
          const paint = original.nodes[source.nodeId].fills.find(paint => paint.visible && paint.kind === 'image')!
          if (await digest(loader(paint.image!).pixels) !== source.decodedSha256)
            throw Error(`${f.name}: browser native PNG decode did not match prepared pixels`)
        }
        for (const candidate of [false, true]) {
          const renderer = await createGpu('webgpu', true, false, f.document.colorManagement, loader, false, true,
            false, false, false, manifest.gpuWorkingBudgetMiB ?? undefined)
          const driver = renderer.driver as WebGpuDriver, originalFinish = driver.finish.bind(driver)
          let observed: Float32Array | undefined, observations = 0, peakTextureBytes = 0
          driver.finish = async (...args: Parameters<WebGpuDriver['finish']>) => {
            if (args[4] !== false || args[6] !== true) throw Error('Proof changed the product render admission flags')
            const [target, region] = args
            // Observation only: untouched target, untouched actual scene and
            // normal finish. This extra readback is intentionally test-only.
            const raw = await driver.readSurface(target)
            proofReadbackBytes += raw.byteLength
            observed = crop(raw, region, f.output); observations++
            return originalFinish(...args)
          }
          const imagePins = () => {
            const pins = (renderer as unknown as { sequentialImagePins: Set<unknown> }).sequentialImagePins
            if (!(pins instanceof Set)) throw Error('Missing actual renderer image-pin ownership set')
            return pins.size
          }
          const run = async (scene: GpuScene, isCurrent?: () => boolean) => {
            try {
              const result = await renderer.render(scene, false, true, isCurrent)
              peakTextureBytes = Math.max(peakTextureBytes, result.peakTextureBytes)
              result.bitmap?.close(); if (result.gpuTile) driver.releasePresented?.([result.gpuTile])
              return result
            } finally {
              // Inspect actual production ownership after success, explicit
              // rejection and cancellation, including rejected-image fixtures.
              if (imagePins() !== 0) throw Error(`${f.name}: renderer retained frame-scoped image pins`)
            }
          }
          try {
            const scene = { ...original, sequentialDisplay: candidate }
            const before = JSON.stringify(original)
            let cancellation: (typeof cancellationRecords)[number] | undefined
            if (candidate && f.admitted && ['image-fractional-cover-boundary', 'image-contain-negative-roi-three-bands'].includes(f.name)) {
              let current = true, copiedBands = 0, cancelled = false
              const originalCopy = driver.copyRegion
              driver.copyRegion = (...args: Parameters<WebGpuDriver['copyRegion']>) => {
                // Run the real GPU copy before withdrawing the owner. The
                // renderer must abandon/fence its actual commands itself.
                originalCopy.apply(driver, args)
                copiedBands++
                if (copiedBands === 1) current = false
              }
              try { await run(scene, () => current) }
              catch (error) {
                if (!(error instanceof Error) || error.message !== 'PREVIEW_CANCELLED') throw error
                cancelled = true
              } finally { driver.copyRegion = originalCopy }
              const framesAfterCancel = renderer.memoryPolicy().sequentialDisplayFrames, pinsAfterCancel = imagePins()
              if (!cancelled || copiedBands !== 1 || observations !== 0 || framesAfterCancel !== 0 || pinsAfterCancel !== 0)
                throw Error(`${f.name}: cancellation did not retain the real first-band boundary: ${JSON.stringify({
                  cancelled, copiedBands, observations, framesAfterCancel, pinsAfterCancel })}`)
              cancellation = { name: f.name, bandCopiesBeforeCancel: copiedBands, finishObservationsAfterCancel: observations,
                sequentialFramesAfterCancel: framesAfterCancel, imagePinsAfterCancel: pinsAfterCancel }
              cancellationRecords.push(cancellation)
            }
            let rejected = false
            try { await run(scene) }
            catch (error) {
              if (!candidate || f.admitted || !String(error).includes('SEQUENTIAL_DISPLAY_UNSUPPORTED')) throw error
              rejected = true
            }
            if (JSON.stringify(original) !== before) throw Error(`${f.name}: native reference scene was mutated`)
            const policy = renderer.memoryPolicy()
            if (policy.workingBudgetBytes !== (manifest.gpuWorkingBudgetMiB ?? 256) * 1024 * 1024)
              throw Error(`${f.name}: configured working budget did not reach the actual renderer`)
            if (candidate && f.admitted && policy.sequentialDisplayFrames !== 1) throw Error(`${f.name}: sequential route did not execute`)
            if ((!candidate || !f.admitted) && policy.sequentialDisplayFrames !== 0) throw Error(`${f.name}: unexpected sequential execution`)
            if (candidate && !f.admitted) {
              if (!rejected || observations) throw Error(`${f.name}: unsupported scene reached finish`)
              await run({ ...original, sequentialDisplay: false })
              if (renderer.memoryPolicy().sequentialDisplayFrames !== 0) throw Error(`${f.name}: fallback silently kept candidate enabled`)
            }
            if (observations !== 1 || !observed) throw Error(`${f.name}: missing actual target observation`)
            if (!candidate) reference = observed
            else {
              if (!reference) throw Error(`${f.name}: missing independent four-plane reference`)
              const comparison = await compare(f.name, reference, observed)
              if (cancellation) cancellation.recoveredRawDifferences = comparison.rawDifferences
              components += comparison.components; sequentialFrames += policy.sequentialDisplayFrames
              records.push({ name: f.name, admitted: f.admitted, rejected, nativeSceneSha256: f.nativeSceneSha256,
                output: f.output, imageSources: f.imageSources, preparedImageIds: f.preparedImageIds,
                bands: f.plan?.expectedBands ?? 0, ...comparison,
                workingBudgetBytes: renderer.memoryPolicy().workingBudgetBytes, peakTextureBytes,
                adapter: driver.stats().adapter })
            }
          } finally { driver.finish = originalFinish; renderer.dispose() }
        }
      } finally { kernel.free() }
    }
    if (cancellationRecords.length !== 2 || cancellationRecords.some(record => record.recoveredRawDifferences !== 0))
      throw Error('The two actual PNG cancellation/recovery cases did not complete')
    return { ...manifest, components, sequentialFrames, proofReadbackBytes, cancellationCases: cancellationRecords.length,
      cancellationRecords, records,
      scope: 'Actual production WebGPU raw-target parity and rejection/recovery. Proof target reads are extra synchronization and cannot establish product latency, zero production readback, screenshot quality or physical FPS.' }
  }, { fixtures: prepared, manifest }))
})
