/** Real WASM/PNG -> production resident WebGPU lifecycle proof.
 * Raw-target COPY_SRC observers keep independent textures before ordinary
 * finish. There are no inter-frame readbacks. Final proof copies/readbacks and
 * the explicit admission probe are instrumentation, never latency evidence. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { initSync, VectorEngine, encode_png_rgba, image_sampling_axes_placed } from '../src/generated/design-kernel/design_kernel.js'
import type { GpuScene } from '../src/kernel/gpu/types'
import { intersect } from '../src/kernel/gpu/types'
import { fullSampleCoverage } from '../src/kernel/gpu/horizontal-filter-cache'
import { certifyExactImageRange, planExactImageXTable } from '../src/kernel/gpu/exact-image-x-table'
import { project, runProof, sha256 } from './exact-prefix-proof-utils'

if (process.env.VITE_DESIGN_GPU_TIMINGS === '1') throw Error('This proof requires timestamp queries disabled')
if (process.env.VITE_DESIGN_RESIDENT_FILTER_SCRATCH !== '1') throw Error('Explicitly enable the resident filter scratch candidate')
if (process.env.VITE_DESIGN_EXACT_IMAGE_X_TABLE === '0') throw Error('This proof requires the production exact X-table route')
if (process.env.VITE_DESIGN_STATIC_IMAGE_BLUR_CACHE === '1') throw Error('Disable static blur caching: every frame must execute the filter')

await runProof('futureox-resident-filter-lifetime', [], async proof => {
  const wasm = await readFile(join(project, 'public/kernel/design_kernel_bg.wasm'))
  initSync({ module: wasm })
  const width = 29, height = 23, rgba = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) rgba.set([(i * 37 + 19) % 256, (i * 17 + 53) % 256, (i * 71 + 11) % 256, 255], i * 4)
  const png = encode_png_rgba(width, height, rgba), uri = 'data:image/png;base64,' + Buffer.from(png).toString('base64')
  const colorManagement = { documentSpace: 'srgb-linear' as const, referenceWhiteNits: 203, peakLuminanceNits: 1000 }
  const fixtures = [
    { name: 'integer-radius-three-frames-admission', radius: 32, zoom: 1, size: 64, frames: 3, pressure: true, cancel: false },
    { name: '117-style-fractional-four-frames', radius: 19.129743576049805, zoom: 2, size: 56, frames: 4, pressure: false, cancel: true },
    { name: '117-style-3200-percent-eight-frames', radius: 38.25948715209961, zoom: 32, size: 24, frames: 8, pressure: false, cancel: false },
  ].map(spec => {
    const document = { schemaVersion: 5, id: 'resident-' + spec.name, name: spec.name, colorManagement,
      pages: [{ id: 'p', name: 'p', background: '#172a3c', children: ['image'] }], nodes: {
        image: { id: 'image', kind: 'rectangle', width: 4096, height: 3072,
          // Like the measured 117 reflected image, preserve the authored tiny
          // off-axis terms. An exact axis-aligned rectangle compiles native
          // header 4, deliberately outside the existing table coverage gate.
          // This actual transform compiles the supported native sample rows;
          // no scene interval/header/certificate is synthesized or patched.
          transform: [-1, -2.4492935982947064e-16, -2.4492935982947064e-16, 1, 2200, -1400], opacity: 1, blend: 'normal', visible: true,
          fills: [{ kind: 'image', image: uri, fit: 'cover', color: '#ffffff', opacity: 1, blend: 'normal', visible: true }],
          children: [], strokes: [], effects: [{ kind: 'blur', visible: true, radius: spec.radius,
            x: 0, y: 0, spread: 0, color: '#000000', opacity: 1, amount: 0 }], clip: false, mask: false },
      } }
    const options = Array.from({ length: spec.frames + Number(spec.cancel) }, (_, index) => ({
      pageId: 'p', width: spec.size, height: spec.size, view: { x: .125 + index * .125, y: .375 + index * .0625, zoom: spec.zoom },
      transparent: true, grid: false, rasterProfile: 'figmaSubpixel', captureViewport: { x: 0, y: 0, w: spec.size, h: spec.size },
    }))
    const engine = new VectorEngine()
    try {
      engine.load_document(JSON.stringify(document))
      const native = options.map(option => engine.compile_gpu(JSON.stringify(option)))
      const scenes = native.map(value => JSON.parse(value) as GpuScene)
      if (scenes.some(scene => !scene.floatCompositing || !scene.coherentSamples || !scene.integratedBlur ||
          scene.resolve || scene.presentation || scene.displayFilters || scene.displayImageSource || scene.displayMaterialSource || scene.sequentialDisplay))
        throw Error(spec.name + ': expected untouched native managed coherent exact-filter scenes')
      const decoded = engine.image_linear(uri)
      if (!decoded.every(Number.isFinite)) throw Error('Actual PNG decoder produced nonfinite pixels')
      const scene = scenes[0], n = scene.nodes.image, radius = spec.radius * spec.zoom
      const output = intersect(n.rect, scene.extent), reach = Math.ceil(radius) + 1
      const input = intersect(n.rect, { x: output.x - reach, y: output.y - reach, w: output.w + reach * 2, h: output.h + reach * 2 })
      const range = certifyExactImageRange(decoded)
      const paint = n.fills.find(p => p.kind === 'image')!
      const axes = Array.from({ length: 4 }, (_, sample) => image_sampling_axes_placed(JSON.stringify(input),
        new Float64Array(n.matrix), new Float64Array(n.size), new Uint32Array([width, height]),
        JSON.stringify({ kind: 'image', color: paint.color, fit: paint.fit, transform: paint.transform, tile: paint.tile }), sample, 0, new Int32Array([0, 0])))
      const tablePlan = range && planExactImageXTable({ axes, width: input.w, height: input.h, imageWidth: width, imageHeight: height, range,
        maxTableBytes: 32 * 1024 * 1024 })
      const nativeAdmission = { output, input, nodeRect: n.rect, fillRect: n.fill.rect, fillCount: n.fill.count, sampleCount: n.fill.sampleCount,
        area: n.fill.area ?? null, areaHeader: n.fill.area ? scene.curves?.slice(n.fill.area.first * 4, n.fill.area.first * 4 + 4) : null,
        fullSampleCoverage: fullSampleCoverage(n.fill, scene.curves, input), matrix: n.matrix, nodeSize: n.size,
        compactImageFields: scene.compactImageFields ?? null, fieldWords: axes.map(axis => axis.length), fieldHeaders: axes.map(axis => [...axis.slice(0, 4)]),
        range: range ?? null, tablePlan: tablePlan ? { tableBytes: tablePlan.tableBytes, rowCount: tablePlan.rowCount, maxKx: tablePlan.maxKx, maxKy: tablePlan.maxKy } : null }
      if (!nativeAdmission.fullSampleCoverage || !tablePlan)
        throw Error(spec.name + ': actual native table preflight rejected ' + JSON.stringify(nativeAdmission))
      return { ...spec, document, options, nativeSceneSha256: native.map(sha256),
        documentSha256: sha256(JSON.stringify(document)), decodedSha256: sha256(new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength)),
        effectiveRadius: spec.radius * spec.zoom, nativeAdmission }
    } finally { engine.free() }
  })
  const manifest = { wasmSha256: sha256(wasm), pngSha256: sha256(png), cases: fixtures.length,
    source: 'Synthetic real PNG and actual WASM-authored rectangle/blur scenes. The fractional radii and 3200% zoom model the 117 filter; this is not the complete 117 document.',
    gate: 'Every candidate raw RGBA32F component must equal strict-boundary control as Uint32, with zero nonfinite values. Actual X-table builds, prefix GPU counters, deferred source pins, periodic drains, real pressure admission, cancellation and recovery are required.',
    deviceIsolation: 'Every proof-owned driver disables only its dispose-time parking key. Each control/candidate group gets an independent device, untouched production allocation/sampling certificates and fresh driver-lifetime counters. This proof does not test parked-device revival.',
    scope: 'Pixel and resource-lifetime proof only. Extra raw COPY_SRC textures and final readbacks alter memory/synchronization; no editor latency, physical FPS, screenshot/no-blur or whole-document claim.' }
  await proof.write('fixtures.json', { ...manifest, fixtures })
  if (proof.prepareOnly) return { ...manifest, scope: 'Actual WASM compilation/PNG decode only; no GPU has run.' }
  return proof.browser(page => page.evaluate(async ({ fixtures, manifest }) => {
    const { initializeKernelModule } = await import('/src/kernel/module.ts')
    const { VectorEngine } = await import('/src/generated/design-kernel/design_kernel.js')
    const { createGpu } = await import('/src/kernel/gpu/factory.ts')
    type Driver = import('/src/kernel/gpu/webgpu.ts').WebGpuDriver
    type Scene = import('/src/kernel/gpu/types.ts').GpuScene
    type Texture = import('/src/kernel/gpu/types.ts').Texture
    type Table = import('/src/kernel/gpu/types.ts').ExactImageTable
    const digest = async (value: string | Float32Array) => {
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(v => v.toString(16).padStart(2, '0')).join('')
    }
    const comparison = async (name: string, reference: Float32Array, actual: Float32Array) => {
      if (reference.length !== actual.length) throw Error(name + ': raw target dimensions changed')
      const a = new Uint32Array(reference.buffer, reference.byteOffset, reference.length), b = new Uint32Array(actual.buffer, actual.byteOffset, actual.length)
      let rawDifferences = 0, nonfinite = 0
      const examples: unknown[] = []
      for (let i = 0; i < a.length; i++) {
        if (!Number.isFinite(reference[i]) || !Number.isFinite(actual[i])) nonfinite++
        if (a[i] !== b[i]) { rawDifferences++; if (examples.length < 8) examples.push({ component: i, reference: a[i], actual: b[i] }) }
      }
      const record = { components: a.length, rawDifferences, nonfinite, referenceSha256: await digest(reference), actualSha256: await digest(actual), examples }
      if (rawDifferences || nonfinite) throw Error(name + ': raw parity failed ' + JSON.stringify(record))
      return record
    }
    await initializeKernelModule()
    const records: unknown[] = [], comparisons: unknown[] = []
    let components = 0, proofReadbackBytes = 0
    for (const fixture of fixtures) {
      const engine = new VectorEngine()
      try {
        engine.load_document(JSON.stringify(fixture.document))
        const natives = fixture.options.map(options => engine.compile_gpu(JSON.stringify(options)))
        for (let i = 0; i < natives.length; i++) if (await digest(natives[i]) !== fixture.nativeSceneSha256[i])
          throw Error(fixture.name + ': actual browser/native scene changed')
        const scenes = natives.map(native => JSON.parse(native) as Scene)
        const decoded = new Map<string, { width: number; height: number; pixels: Float32Array; bytes?: Uint8Array }>()
        const loader = (uri: string, byte = false, level = 0) => {
          if (level !== 0) throw Error('This proof must not enable image mipmaps')
          const key = JSON.stringify([uri, byte]); let image = decoded.get(key)
          if (!image) {
            const [width, height] = JSON.parse(engine.image_info(uri)) as [number, number]
            image = { width, height, pixels: engine.image_linear(uri), ...(byte ? { bytes: engine.image_rgba8(uri) } : {}) }
            decoded.set(key, image)
          }
          return image
        }
        if (await digest(loader(fixture.document.nodes.image.fills[0].image).pixels) !== fixture.decodedSha256)
          throw Error(fixture.name + ': actual browser PNG decode changed')
        let reference: Float32Array[] | undefined
        for (const candidate of [false, true]) {
          const renderer = await createGpu('webgpu', true, false, fixture.document.colorManagement, loader, false, true, false, false, false)
          const driver = renderer.driver as Driver
          // Private state is inspected, never fabricated. The control changes
          // only the retired lifetime policy to reproduce the former boundary.
          const raw = driver as any, owner = renderer as any
          // This owned proof must compare independent groups, not revive a
          // control's parked driver with lifetime counters and observer state.
          // Only disposal policy changes; no resource proof/admission changes.
          raw.poolKey = undefined
          const originalResidentFilterScratch = raw.residentFilterScratch, originalCaptureDisplay = driver.captureDisplay
          if (!raw.residentFilterScratch || raw.timingQueries) throw Error('Resident candidate/timing admission changed')
          const initialStats = driver.stats()
          if (initialStats.residentCaptures || initialStats.prefixCounterSamples || initialStats.prefixCounterDeferredFrames ||
              initialStats.queueWaits.reasons.periodic.completed)
            throw Error('Proof group did not receive independent fresh driver-lifetime counters')
          if (!candidate) raw.residentFilterScratch = false
          driver.attachPresenter(new OffscreenCanvas(fixture.size, fixture.size), () => {})
          driver.captureDisplay = true
          const originals = { finish: driver.finish, retire: driver.retireImageTable, checkpoint: driver.checkpoint,
            destroy: driver.destroy, prepareFilters: driver.prepareFilters }
          const originalPrepareTable = owner.prepareFilterImageTable
          const retained: { texture: Texture; width: number; height: number }[] = [], proofTextures = new Set<Texture>()
          const frameRecords: unknown[] = [], retirements: unknown[] = [], checkpoints: unknown[] = [], counters: unknown[] = []
          const tableAttempts: unknown[] = []
          const prefixOriginals = new Map<any, { encode: any; readCounters: any }>()
          let cancelArmed = false, current = true, cancelledPrefixEncodes = 0, prefixEncodes = 0, prefixWrapped: any
          const ledger = (where: string) => {
            const physical = [...raw.textures as Set<Texture>].filter(texture => texture !== raw.blank && !proofTextures.has(texture))
              .reduce((total, texture) => total + texture.bytes, driver.scratchBytes)
            if (physical !== owner.bytes) throw Error(`${fixture.name}/${candidate}/${where}: scratch ledger diverged ${physical} != ${owner.bytes}`)
            return { rendererBytes: owner.bytes, actualTextureAndScratchBytes: physical, scratchBytes: driver.scratchBytes,
              retiredImageTableBytes: driver.retiredImageTableBytes, proofCopyBytes: [...proofTextures].reduce((sum, texture) => sum + texture.bytes, 0) }
          }
          driver.destroy = function(texture: Texture) {
            if (driver.hasActiveImageTableSource(texture)) throw Error('Production destroyed a still-pinned X-table source')
            return originals.destroy.call(driver, texture)
          }
          driver.prepareFilters = async function(...args: Parameters<Driver['prepareFilters']>) {
            await originals.prepareFilters.apply(driver, args)
            if (raw.prefix && prefixWrapped !== raw.prefix) {
              prefixWrapped = raw.prefix
              const prefix = raw.prefix, encode = prefix.encode, readCounters = prefix.readCounters
              prefixOriginals.set(prefix, { encode, readCounters })
              raw.prefix.encode = (...args: unknown[]) => {
                const value = encode.apply(prefix, args)
                if (value) {
                  prefixEncodes++
                  if (cancelArmed) { cancelledPrefixEncodes++; current = false }
                }
                return value
              }
              raw.prefix.readCounters = async () => { const value = await readCounters.call(prefix); counters.push(value); return value }
            }
          }
          owner.prepareFilterImageTable = async function(...args: any[]) {
            const table = await originalPrepareTable.apply(owner, args)
            // Observe actual uploaded certificates after the unmodified
            // production admission. No image/field is injected or uploaded by
            // the diagnostic; this also makes a rejected fixture actionable.
            tableAttempts.push({ admitted: !!table, tableBytes: table?.bytes ?? 0, input: args[1],
              actualImages: [...owner.images.values()].map((image: any) => ({ rect: image.rect,
                finitePixels: image.texture.finitePixels === true, range: driver.imageTableRange(image.texture) ?? null,
                usesDisplayImageSource: driver.usesDisplayImageSource(image.texture) })),
              actualFieldHeaders: owner.filterImageFields ? [...owner.filterImageFields.fields.values()].map((field: any) => {
                const axes = driver.imageTableAxes(field.texture)
                return { rect: field.rect, words: axes?.length ?? 0, header: axes ? [...axes.slice(0, 4)] : null }
              }) : [],
              policy: { managed: driver.managed, displayMath: driver.displayMath, imageMips: owner.imageMips,
                compactImageFields: owner.scene.compactImageFields ?? null, integratedBlur: owner.scene.integratedBlur } })
            return table
          }
          driver.retireImageTable = async function(table: Table) {
            const entry = raw.imageTables.get(table), beforeBytes = driver.scratchBytes
            if (!entry || !driver.hasActiveImageTableSource(entry.image)) throw Error('Actual table/source ownership missing before retirement')
            await originals.retire.call(driver, table)
            if (!raw.imageTables.get(table)?.retired || !driver.hasActiveImageTableSource(entry.image) || driver.scratchBytes !== beforeBytes)
              throw Error('Logical table retirement freed scratch/source before a completion boundary')
            retirements.push({ bytes: table.bytes, retainedUntilCheckpoint: true, epoch: driver.resourceEpoch })
            if (!candidate) await driver.checkpoint('image-table-scratch')
          }
          driver.checkpoint = async function(...args: Parameters<Driver['checkpoint']>) {
            const retired = [...raw.imageTables].filter(([, entry]: any) => entry.retired).map(([table]: any) => table)
            const before = driver.completedResourceEpoch
            await originals.checkpoint.apply(driver, args)
            if (retired.some(table => raw.imageTables.has(table))) throw Error('Completed actual checkpoint retained covered retired table storage')
            checkpoints.push({ reason: args[0] ?? 'checkpoint', retiredTablesCovered: retired.length,
              completedEpochBefore: before, completedEpochAfter: driver.completedResourceEpoch })
          }
          driver.finish = async function(...args: Parameters<Driver['finish']>) {
            if (args[4] !== false || args[6] !== true) throw Error('Observer changed readback/present admission')
            const source = args[0], texture = driver.create(source.width, source.height)
            proofTextures.add(texture)
            // Exact raw bytes of the original target, no resolve/crop/transform.
            driver.copyRegion(texture, source, { x: 0, y: 0, w: source.width, h: source.height }, [0, 0])
            retained.push({ texture, width: source.width, height: source.height })
            return originals.finish.apply(driver, args)
          }
          const run = async (scene: Scene, isCurrent?: () => boolean) => {
            const result = await renderer.render(scene, false, true, isCurrent)
            result.bitmap?.close(); if (result.gpuTile) driver.releasePresented([result.gpuTile])
            if (!result.imageXTableBuilds || !result.imageXTablePixels || !driver.stats().residentCaptures)
              throw Error(fixture.name + ': real X-table/resident route did not execute ' + JSON.stringify({ candidate,
                imageXTableBuilds: result.imageXTableBuilds, imageXTablePixels: result.imageXTablePixels,
                residentCaptures: driver.stats().residentCaptures, wholeFilterAxes: result.wholeFilterAxes, prefixEncodes,
                nativeAdmission: fixture.nativeAdmission, tableAttempts,
                fallbackReason: !tableAttempts.length ? 'stream/table preparation was not called' :
                  !(tableAttempts as { admitted: boolean }[]).some(row => row.admitted) ? 'production table preparation declined: see real upload certificates/policy' :
                    !result.imageXTablePixels ? 'table built but source resolve did not execute' : 'resident capture did not execute' }))
            frameRecords.push({ imageXTableBuilds: result.imageXTableBuilds, imageXTablePixels: result.imageXTablePixels,
              wholeFilterAxes: result.wholeFilterAxes, prefixEncodes, ...ledger('frame'), stats: driver.stats() })
          }
          let pressure: unknown, cancellation: unknown
          try {
            // No observer reads, checkpoint injections or clone synchronization
            // between these consecutive ordinary product frames.
            let residentPrefix: unknown
            for (let frame = 0; frame < fixture.frames; frame++) {
              await run(scenes[frame])
              if (candidate) {
                const count = frame + 1, stats = driver.stats(), drains = Math.floor(count / 4)
                if (stats.prefixCounterSamples !== drains || stats.prefixCounterDeferredFrames !== count - drains ||
                    stats.queueWaits.reasons.periodic.completed !== drains)
                  throw Error(`Candidate changed the actual fourth-frame periodic/counter boundary at frame ${count}`)
                if (!raw.prefix?.prefix || residentPrefix && residentPrefix !== raw.prefix.prefix)
                  throw Error('Candidate replaced its resident prefix buffer between ordinary frames')
                residentPrefix = raw.prefix.prefix
                const tables = [...raw.imageTables.values()] as { image: Texture; retired: boolean }[]
                if (count % 4 === 0 ? tables.length !== 0 : !tables.length)
                  throw Error('Retired tables did not follow the actual periodic completion boundary')
                for (const entry of tables)
                  if (!entry.retired || !raw.textures.has(entry.image) || !driver.hasActiveImageTableSource(entry.image))
                    throw Error('A deferred retired table lost its live source pin')
              }
            }
            const beforeProofDrain = driver.stats(), continuousLedger = ledger('continuous-group')
            if (beforeProofDrain.rasterReadbackBytes !== 0 || retained.length !== fixture.frames || !prefixEncodes)
              throw Error('Missing continuous original frames or unexpected product raster readback')
            if (candidate && fixture.frames >= 4 && (!beforeProofDrain.prefixCounterSamples || !counters.length))
              throw Error('Existing fourth-frame periodic drain did not read real prefix counters')
            if (candidate && !beforeProofDrain.prefixCounterDeferredFrames) throw Error('Candidate never deferred actual prefix counter readback')
            // Ordinary finish consumes its encoder. Only after the complete
            // uninterrupted product group, start a proof-only encoder for
            // admission/counter observations. Do not begin/abort a new product
            // frame: those reset counters or release the state being proved.
            raw.encoder = raw.device.createCommandEncoder()
            if (candidate && fixture.pressure) {
              // Ask the real compositor allocator for the first 4096-wide row
              // beyond its present headroom. Its production reclamation and
              // admission gate decide if that actual texture can be allocated.
              const region = { x: 0, y: 0, w: 4096, h: Math.floor((owner.frameBudget - owner.workingBytes) / (4096 * 16)) + 1 }
              if (region.h < 1 || region.h > 8192 || !driver.retiredImageTableBytes) throw Error('Actual pressure fixture has no bounded retired-table pressure')
              const before = checkpoints.length, required = region.w * region.h * 16
              await owner.reclaimScratch(required)
              let allocated = false, budgetRejected = false
              try { const surface = owner.acquire(region); allocated = true; owner.release(surface) }
              catch (error) { if (!(error instanceof Error) || error.message !== 'GPU 表面内存预算超限') throw error; budgetRejected = true }
              const actual = checkpoints.slice(before) as { reason: string }[]
              if (!actual.some(item => item.reason === 'admission') || driver.retiredImageTableBytes) throw Error('Real allocation pressure did not collect through production admission')
              pressure = { requiredBytes: required, region, allocated, budgetRejected, checkpoints: actual, ...ledger('admission') }
            }
            if (fixture.cancel) {
              const before = retained.length, encodedBefore = prefixEncodes
              let cancelled = false; cancelArmed = true; current = true
              try { await run(scenes[fixture.frames], () => current) }
              catch (error) { if (!(error instanceof Error) || error.message !== 'PREVIEW_CANCELLED') throw error; cancelled = true }
              finally { cancelArmed = false }
              if (!cancelled || !cancelledPrefixEncodes || prefixEncodes === encodedBefore || retained.length !== before || driver.scratchBytes || raw.imageTables.size)
                throw Error('Actual encoded prefix cancellation did not abandon/retire the frame')
              const afterAbort = ledger('cancel')
              await run(scenes[fixture.frames])
              cancellation = { cancelled, cancelledPrefixEncodes, finishObservationsBefore: before, finishObservationsAfterCancel: before, afterAbort,
                recoveryFinishObservations: retained.length - before, ...ledger('recovery') }
              raw.encoder = raw.device.createCommandEncoder()
            }
            const beforeScratch = driver.scratchBytes
            // A three-frame group intentionally has no periodic counter map.
            // Sample its real counters only now, at the common final proof
            // drain, without inserting another product-frame boundary.
            const finalCounterCopy = !!raw.prefix?.scratchBytes
            if (finalCounterCopy) raw.prefix.encodeCountersReadback(raw.encoder)
            await driver.checkpoint('readback')
            // This explicit proof checkpoint can collect table storage, so keep
            // the compositor's normally internal checkpoint ledger adjustment.
            owner.bytes += driver.scratchBytes - beforeScratch
            const proofFinalPrefixCounters = finalCounterCopy ? await raw.prefix.readCounters() : undefined
            if (raw.imageTables.size || driver.retiredImageTableBytes) throw Error('Final real completion retained X-table source pins')
            ledger('proof-drain')
            const values: Float32Array[] = []
            for (const target of retained) {
              const pixels = await driver.readSurface(target.texture)
              if (pixels.length !== target.width * target.height * 4) throw Error('Raw COPY_SRC observation dimensions changed')
              proofReadbackBytes += pixels.byteLength; values.push(pixels)
            }
            if (!candidate) reference = values
            else {
              if (!reference || reference.length !== values.length) throw Error('Missing independently rendered strict-boundary control')
              for (let frame = 0; frame < values.length; frame++) {
                const result = await comparison(`${fixture.name}/${frame}`, reference[frame], values[frame])
                components += result.components; comparisons.push({ name: fixture.name, frame, ...result })
              }
            }
            if (!retirements.length || !counters.some((value: any) => value.acceptedPixels > 0))
              throw Error('Fixture did not execute real table retirement and certified prefix GPU results')
            records.push({ name: fixture.name, candidate, adapter: driver.stats().adapter, effectiveRadius: fixture.effectiveRadius,
              frames: fixture.frames, beforeProofDrain, continuousLedger, frameRecords, retirements, checkpoints, counters,
              proofFinalPrefixCounters, tableAttempts, pressure, cancellation })
          } finally {
            driver.finish = originals.finish; driver.retireImageTable = originals.retire
            driver.checkpoint = originals.checkpoint; driver.prepareFilters = originals.prepareFilters
            owner.prepareFilterImageTable = originalPrepareTable
            for (const [prefix, methods] of prefixOriginals) {
              prefix.encode = methods.encode; prefix.readCounters = methods.readCounters
            }
            raw.residentFilterScratch = originalResidentFilterScratch
            // Release proof-owned textures independently of product ownership.
            try {
              await renderer.abortFrameAndReleaseFilterScratch('cancel')
              for (const texture of proofTextures) driver.destroy(texture)
            } finally {
              driver.destroy = originals.destroy
              driver.captureDisplay = originalCaptureDisplay
              raw.poolKey = undefined
              renderer.dispose()
            }
          }
        }
      } finally { engine.free() }
    }
    return { ...manifest, components, proofReadbackBytes, records, comparisons,
      rawDifferences: 0, nonfinite: 0, scope: manifest.scope }
  }, { fixtures, manifest }))
})
