/** Same-program, same-device raw R32 or packed RGBA8 comparison of original area and the
 * sample-only pipeline. No renderer phase canonicalization participates.
 * Real document/program/pixels remain private. */
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { initSync, VectorEngine } from '../src/generated/design-kernel/design_kernel.js'
import { project, runProof, sha256 } from './exact-prefix-proof-utils'

const documentPath = process.env.DESIGN_COVERAGE_DOCUMENT, requestsPath = process.env.DESIGN_COVERAGE_REQUESTS
const benchmark = process.env.DESIGN_COVERAGE_BENCHMARK === '1'
const formatProbeOnly = process.env.DESIGN_COVERAGE_FORMAT_PROBE_ONLY === '1'
const unmanagedDriver = process.env.DESIGN_COVERAGE_UNMANAGED_DRIVER === '1'
if (!documentPath || !requestsPath || process.env.VITE_DESIGN_SAMPLE_ONLY_COVERAGE !== '1')
  throw Error('Supply actual document/requests and strict sample-only coverage build gate')
await runProof('futureox-sample-only-coverage', [resolve(documentPath), resolve(requestsPath)], async proof => {
  const [documentBytes, requestBytes, wasm, font] = await Promise.all([readFile(documentPath), readFile(requestsPath),
    readFile(join(project, 'public/kernel/design_kernel_bg.wasm')), readFile(join(project, 'public/fonts/NotoSansSC.ttf'))])
  const requests = JSON.parse(requestBytes.toString())
  if (!Array.isArray(requests) || !requests.length) throw Error('An explicit regional request is required')
  const request = { ...requests[0], gpuPainterSupport: true, gpuPainterCaptureReads: true }
  initSync({ module: wasm })
  const engine = new VectorEngine(); let native: string
  try { engine.load_font(font); engine.load_document(documentBytes.toString()); native = engine.compile_gpu(JSON.stringify(request)) }
  finally { engine.free() }
  const scene = JSON.parse(native!), curves = new Float32Array(scene.curves)
  const paths = Object.values(scene.nodes).flatMap((node: any) => [node.fill, ...node.strokes.map((stroke: any) => stroke.path)])
    .filter((path: any) => path?.area && path.count > 0 && path.sampleCount === 4 && [3, 4].includes(curves[path.area.first * 4]) &&
      path.rect.w > 0 && path.rect.h > 0 && path.rect.w * path.rect.h <= 16777216)
  const unique = [3, 4].flatMap(header => [...new Map(paths.map((path: any) => [sha256(JSON.stringify(path)), path])).values()]
    .filter((path: any) => curves[path.area.first * 4] === header)
    .sort((a: any, b: any) => b.rect.w * b.rect.h - a.rect.w * a.rect.h).slice(0, 3))
  if (!unique.length) throw Error('Real compiled scene has no supported four-phase sample program')
  const manifest = { documentSha256: sha256(documentBytes), requestsSha256: sha256(requestBytes),
    executionRequestSha256: sha256(JSON.stringify(request)), wasmSha256: sha256(wasm), fontSha256: sha256(font),
    nativeSceneSha256: sha256(native!), benchmark, formatProbeOnly, unmanagedDriver, paths: unique.map((path: any) => ({ pathSha256: sha256(JSON.stringify(path)),
      width: path.rect.w, height: path.rect.h, header: curves[path.area.first * 4], programWords: path.area.count * 4 })),
    scope: `Actual original area vs sample-only ${unmanagedDriver ? 'normal unmanaged packed RGBA8' : 'R32'} masks for identical freshly compiled real programs, four phases and regional crops. Test explicitly enables owned-driver display policy; no ResidentPresenter or Electron attachment is exercised. No exclusive GPU time or app latency claim.` }
  await proof.write('fixtures.json', manifest)
  if (proof.prepareOnly) return manifest
  const result = await proof.browser(async page => page.evaluate(async payload => {
    const { initializeKernelModule } = await import('/src/kernel/module.ts')
    const { WebGpuDriver } = await import('/src/kernel/gpu/webgpu.ts')
    await initializeKernelModule()
    const digest = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer))]
      .map(value => value.toString(16).padStart(2, '0')).join('')
    if (await digest(new Uint8Array(await (await fetch('/kernel/design_kernel_bg.wasm')).arrayBuffer())) !== payload.manifest.wasmSha256)
      throw Error('Actual browser WASM differs from bound inputs')
    const driver = await WebGpuDriver.create(!payload.manifest.unmanagedDriver, false, !payload.manifest.unmanagedDriver, true, false), raw = driver as any
    const device = raw.device as GPUDevice, records: any[] = [], batches: any[] = []
    let wordsCompared = 0, benchmarkReferenceSha256: string | undefined
    const readWords = async (target: any) => {
      if (payload.manifest.unmanagedDriver
        ? target.scalarCoverage || target.binaryCoverage || target.resource.format !== 'rgba8unorm'
        : !target.scalarCoverage || target.resource.format !== 'r32float') throw Error('Actual raw mask format required')
      await driver.checkpoint('readback')
      const stride = Math.ceil(target.width * 4 / 256) * 256
      const buffer = device.createBuffer({ size: stride * target.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
      try {
        const encoder = device.createCommandEncoder()
        encoder.copyTextureToBuffer({ texture: target.resource }, { buffer, bytesPerRow: stride }, [target.width, target.height])
        device.queue.submit([encoder.finish()]); await buffer.mapAsync(GPUMapMode.READ)
        const mapped = new Uint32Array(buffer.getMappedRange()), words = new Uint32Array(target.width * target.height)
        for (let y = 0; y < target.height; y++) words.set(mapped.subarray(y * stride / 4, y * stride / 4 + target.width), y * target.width)
        buffer.unmap(); return words
      } finally { buffer.destroy() }
    }
    try {
      if (device.adapterInfo.isFallbackAdapter !== false) throw Error('Confirmed non-fallback GPU required')
      // Explicit operator-only display intent. Real ResidentPresenter capture
      // remains disabled; this does not claim an attached desktop scope.
      await driver.prepareScene(payload.scene, true)
      if (payload.manifest.formatProbeOnly) {
        let components = 0, different = 0
        const formatRecords: any[] = []
        for (const [index, path] of payload.paths.entries()) {
          driver.begin(new Float32Array(payload.scene.vertices), new Float32Array(payload.scene.curves))
          const regions = [
            { x: path.rect.x - 2, y: path.rect.y - 2, w: 17, h: 7 },
            { x: path.rect.x + Math.floor(path.rect.w / 2), y: path.rect.y + Math.floor(path.rect.h / 2), w: 17, h: 7 },
          ]
          let binaryZero = 0, binaryOne = 0
          for (let phase = 0; phase < 4; phase++) for (const [regionIndex, region] of regions.entries()) {
            let scalar: Uint32Array | undefined
            for (const format of payload.manifest.unmanagedDriver ? ['rgba8unorm'] : ['r32float', 'rgba8unorm', 'rgba32float']) {
              let reference: Uint32Array | undefined
              for (const candidate of [false, true]) {
                raw.sampleOnlyCoverageEnabled = candidate
                const before = raw.sampleOnlyCoveragePasses
                const target = payload.manifest.unmanagedDriver ? driver.create(region.w, region.h)
                  : format === 'r32float' ? driver.createScalarCoverage(region.w, region.h)
                  : format === 'rgba8unorm' ? driver.createBinaryCoverage(region.w, region.h) : driver.create(region.w, region.h)
                try {
                  if ((target.resource as GPUTexture).format !== format) throw Error('Actual target format mismatch')
                  driver.maskRegion(path, target, phase, region)
                  const words = format === 'r32float' ? await readWords(target)
                    : new Uint32Array((await driver.readSurface(target)).buffer)
                  const hit = raw.sampleOnlyCoveragePasses - before
                  if (hit !== (candidate ? 1 : 0)) throw Error('Format probe did not execute controlled pipeline')
                  if (words.some(word => word !== 0 && word !== 0x3f800000)) throw Error('Nonbinary format probe result')
                  if (!candidate) {
                    reference = words
                    if (format === 'r32float') {
                      scalar = words
                      binaryZero += words.filter(word => word === 0).length
                      binaryOne += words.filter(word => word === 0x3f800000).length
                    } else if (payload.manifest.unmanagedDriver) {
                      scalar = Uint32Array.from({ length: words.length / 4 }, (_, i) => words[i * 4])
                      binaryZero += scalar.filter(word => word === 0).length
                      binaryOne += scalar.filter(word => word === 0x3f800000).length
                    }
                  } else {
                    if (!reference || !scalar) throw Error('Original scalar/format reference missing')
                    let differences = 0
                    for (let i = 0; i < words.length; i++)
                      if (words[i] !== reference[i] || words[i] !== scalar[format === 'r32float' ? i : Math.floor(i / 4)]) differences++
                    components += words.length; different += differences
                    formatRecords.push({ index, phase, regionIndex, format, comparedComponents: words.length, different: differences,
                      actualPipelineHits: hit })
                    if (differences) throw Error('Sample-only format differs from original scalar/format reference')
                  }
                } finally { driver.destroy(target) }
              }
            }
          }
          if (!binaryZero || !binaryOne) throw Error('Format probes did not exercise both empty and occupied samples')
          const completionTarget = payload.manifest.unmanagedDriver ? driver.create(1, 1) : driver.createScalarCoverage(1, 1)
          try { await driver.finish(completionTarget, path.rect, path.rect.w, path.rect.h, false, undefined, false) }
          finally { driver.destroy(completionTarget) }
        }
        return { status: 'passed', adapter: driver.stats().adapter, nonFallbackAdapterVerified: true, components, different,
          formatRecords, scope: `${payload.manifest.unmanagedDriver ? 'Actual normal unmanaged RGBA8' : 'Three actual GPU formats'} and four phases, including empty/occupied edge samples; no timings or full-editor claim.` }
      }
      for (const [index, path] of payload.paths.entries()) {
        driver.begin(new Float32Array(payload.scene.vertices), new Float32Array(payload.scene.curves))
        const phases: any[] = []
        for (let phase = 0; phase < 4; phase++) {
          let reference: Uint32Array | undefined
          const regions = [{ ...path.rect },
            { x: path.rect.x, y: path.rect.y, w: Math.min(17, path.rect.w), h: Math.min(5, path.rect.h) },
            { x: path.rect.x + path.rect.w - Math.min(7, path.rect.w), y: path.rect.y + path.rect.h - Math.min(3, path.rect.h),
              w: Math.min(7, path.rect.w), h: Math.min(3, path.rect.h) }]
          for (const candidate of [false, true]) {
            // Test-only negative route on this owned driver. No shader,
            // upload, program, remapping, texture format or uniforms change.
            raw.sampleOnlyCoverageEnabled = candidate
            const startHits = raw.sampleOnlyCoveragePasses
            let compared = 0, differences = 0
            for (const [regionIndex, region] of regions.entries()) {
              if (!candidate && regionIndex !== 0) continue
          const target = payload.manifest.unmanagedDriver ? driver.create(region.w, region.h) : driver.createScalarCoverage(region.w, region.h)
              try {
                if (regionIndex === 0) driver.mask(path, target, phase)
                else driver.maskRegion(path, target, phase, region)
                const words = await readWords(target)
                if (words.some(value => value !== 0 && value !== (payload.manifest.unmanagedDriver ? 0xffffffff : 0x3f800000)))
                  throw Error('Nonbinary sample result')
                if (!candidate) {
                  reference = words
                  if (index === 0 && phase === 3)
                    benchmarkReferenceSha256 = await digest(new Uint8Array(words.buffer, words.byteOffset, words.byteLength))
                }
                else {
                  if (!reference) throw Error('Original full phase reference missing')
                  for (let y = 0; y < region.h; y++) for (let x = 0; x < region.w; x++) {
                    const expected = reference[(region.y - path.rect.y + y) * path.rect.w + region.x - path.rect.x + x]
                    if (words[y * region.w + x] !== expected) differences++
                  }
                  compared += words.length; wordsCompared += words.length
                }
              } finally { driver.destroy(target) }
            }
            const actualHits = raw.sampleOnlyCoveragePasses - startHits
            if (candidate ? actualHits !== regions.length : actualHits !== 0) throw Error('Actual selected pipeline did not match controlled route')
            if (differences) throw Error('Sample-only mask differs from original area')
            phases.push({ phase, candidate, actualPipelineHits: actualHits, comparedWords: compared, different: differences })
          }
        }
        records.push({ index, width: path.rect.w, height: path.rect.h, phases })
        const completionTarget = payload.manifest.unmanagedDriver ? driver.create(1, 1) : driver.createScalarCoverage(1, 1)
        try { await driver.finish(completionTarget, path.rect, path.rect.w, path.rect.h, false, undefined, false) }
        finally { driver.destroy(completionTarget) }
      }
      if (payload.manifest.benchmark) {
        const path = payload.paths[0], target = payload.manifest.unmanagedDriver
          ? driver.create(path.rect.w, path.rect.h) : driver.createScalarCoverage(path.rect.w, path.rect.h)
        driver.begin(new Float32Array(payload.scene.vertices), new Float32Array(payload.scene.curves))
        try {
          for (const candidate of [false, true]) {
            raw.sampleOnlyCoverageEnabled = candidate; driver.mask(path, target, 0)
            await driver.checkpoint('timing')
          }
          // Three balanced ABBA blocks. Pipelines/program uploads are already
          // warm; per-trial completion is real, but includes CPU encoding and
          // driver/queue overhead. No timestamps or exclusive GPU attribution.
          for (let block = 0; block < 3; block++) for (const candidate of [false, true, true, false]) {
            raw.sampleOnlyCoverageEnabled = candidate
            const hits = raw.sampleOnlyCoveragePasses, start = performance.now()
            for (let iteration = 0; iteration < 8; iteration++) driver.mask(path, target, iteration % 4)
            const encodeMs = performance.now() - start
            await driver.checkpoint('timing')
            const encodeAndQueueCompletionMs = performance.now() - start, actualPipelineHits = raw.sampleOnlyCoveragePasses - hits
            if (actualPipelineHits !== (candidate ? 8 : 0)) throw Error('Timed pipeline route did not execute')
            batches.push({ block, candidate, draws: 8, encodeMs, encodeAndQueueCompletionMs, actualPipelineHits })
          }
          const final = await readWords(target)
          if (await digest(new Uint8Array(final.buffer, final.byteOffset, final.byteLength)) !== benchmarkReferenceSha256)
            throw Error('Timed mask batch changed its last-phase result')
          await driver.finish(target, path.rect, path.rect.w, path.rect.h, false, undefined, false)
        } finally { driver.destroy(target) }
      }
      return { status: 'passed', adapter: driver.stats().adapter, nonFallbackAdapterVerified: true, wordsCompared, different: 0,
        rawMaskFormat: payload.manifest.unmanagedDriver ? 'rgba8unorm-packed-u32' : 'r32float', records, batches,
        timingScope: 'Optional warm mask batches include CPU encoding and real queue completion, balanced ABBA; not exclusive shader time, FPS or app input latency.' }
    } catch (error) {
      await driver.abortFrameAndReleaseFilterScratch('cancel').catch(() => {})
      return { status: 'failed', adapter: driver.stats().adapter, wordsCompared, records, error: String(error), stack: error instanceof Error ? error.stack : undefined }
    } finally { driver.dispose() }
  }, { scene, paths: unique, manifest }))
  await proof.write('gpu-result.json', result)
  if (result.status !== 'passed') throw Error(result.error || 'Sample-only coverage GPU oracle failed')
  return { ...manifest, ...result }
})
