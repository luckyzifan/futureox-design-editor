import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { initSync, VectorEngine } from '../src/generated/design-kernel/design_kernel.js'
import { project, runProof, sha256 } from './exact-prefix-proof-utils'

const documentPath = process.env.DESIGN_COVERAGE_DOCUMENT, requestsPath = process.env.DESIGN_COVERAGE_REQUESTS
if (!documentPath || !requestsPath || process.env.VITE_DESIGN_SAMPLE_ONLY_COVERAGE !== '1' || process.env.VITE_DESIGN_PACKED_COVERAGE !== '1')
  throw Error('Supply actual document/requests and both strict coverage build gates')
await runProof('futureox-packed-coverage', [resolve(documentPath), resolve(requestsPath)], async proof => {
  const [documentBytes, requestBytes, wasm, font] = await Promise.all([readFile(documentPath), readFile(requestsPath),
    readFile(join(project, 'public/kernel/design_kernel_bg.wasm')), readFile(join(project, 'public/fonts/NotoSansSC.ttf'))])
  const requests = JSON.parse(requestBytes.toString()), request = requests[0]
  initSync({ module: wasm })
  const engine = new VectorEngine(); let native: string
  try { engine.load_font(font); engine.load_document(documentBytes.toString()); native = engine.compile_gpu(JSON.stringify(request)) }
  finally { engine.free() }
  const scene = JSON.parse(native!), curves = new Float32Array(scene.curves)
  const paths = Object.values(scene.nodes).flatMap((node: any) => [node.fill, ...node.strokes.map((stroke: any) => stroke.path)])
    .filter((path: any) => path?.area && path.count > 0 && path.sampleCount === 4 && [3, 4].includes(curves[path.area.first * 4]) &&
      path.rect.w > 0 && path.rect.h > 0 && path.rect.w * path.rect.h <= 16777216)
  const selected = [3, 4].flatMap(header => [...new Map(paths.map((path: any) => [sha256(JSON.stringify(path)), path])).values()]
    .filter((path: any) => curves[path.area.first * 4] === header)
    .sort((a: any, b: any) => b.rect.w * b.rect.h - a.rect.w * a.rect.h).slice(0, 1))
  if (selected.length !== 2) throw Error('Both interval and rectangle coverage programs are required')
  const manifest = { documentSha256: sha256(documentBytes), requestsSha256: sha256(requestBytes),
    executionRequestSha256: sha256(JSON.stringify(request)), wasmSha256: sha256(wasm), fontSha256: sha256(font), nativeSceneSha256: sha256(native!),
    paths: selected.map((path: any) => ({ pathSha256: sha256(JSON.stringify(path)), width: path.rect.w, height: path.rect.h,
      header: curves[path.area.first * 4], programWords: path.area.count * 4 })),
    scope: 'Original general area fragment versus four-attachment sample coverage; real non-fallback GPU; full and regional raw RGBA8 comparison; paired queue completion, not FPS or input latency.' }
  await proof.write('fixtures.json', manifest)
  if (proof.prepareOnly) return manifest
  const result = await proof.browser(async page => page.evaluate(async payload => {
    const { initializeKernelModule } = await import('/src/kernel/module.ts')
    const { WebGpuDriver } = await import('/src/kernel/gpu/webgpu.ts')
    await initializeKernelModule()
    const driver = await WebGpuDriver.create(true, false, true, true, false), raw = driver as any, device = raw.device as GPUDevice
    if (device.adapterInfo.isFallbackAdapter !== false) throw Error('Confirmed non-fallback GPU required')
    await driver.prepareScene(payload.scene, true)
    const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2 }
    async function readBytes(target: any) {
      await driver.checkpoint('readback')
      const stride = Math.ceil(target.width * 4 / 256) * 256, buffer = device.createBuffer({ size: stride * target.height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
      try {
        const encoder = device.createCommandEncoder()
        encoder.copyTextureToBuffer({ texture: target.resource }, { buffer, bytesPerRow: stride }, [target.width, target.height])
        device.queue.submit([encoder.finish()]); await buffer.mapAsync(GPUMapMode.READ)
        const mapped = new Uint8Array(buffer.getMappedRange()), bytes = new Uint8Array(target.width * target.height * 4)
        for (let y = 0; y < target.height; y++) bytes.set(mapped.subarray(y * stride, y * stride + target.width * 4), y * target.width * 4)
        buffer.unmap(); return bytes
      } finally { buffer.destroy() }
    }
    const records: any[] = [], batches: any[] = []
    let comparedBytes = 0
    try {
      for (const [index, path] of payload.paths.entries()) {
        driver.begin(new Float32Array(payload.scene.vertices), new Float32Array(payload.scene.curves))
        const regions = [{ ...path.rect },
          { x: path.rect.x, y: path.rect.y, w: Math.min(17, path.rect.w), h: Math.min(5, path.rect.h) },
          { x: path.rect.x + path.rect.w - Math.min(7, path.rect.w), y: path.rect.y + path.rect.h - Math.min(3, path.rect.h),
            w: Math.min(7, path.rect.w), h: Math.min(3, path.rect.h) }]
        const record: any = { index, regions: [] }
        for (const [regionIndex, region] of regions.entries()) {
          const referenceTargets = Array.from({ length: 4 }, () => driver.createBinaryCoverage(region.w, region.h))
          const packedTargets = Array.from({ length: 4 }, () => driver.createBinaryCoverage(region.w, region.h))
          let zero = 0, occupied = 0, different = 0
          try {
            raw.sampleOnlyCoverageEnabled = false
            for (let phase = 0; phase < 4; phase++) driver.mask(path, referenceTargets[phase], phase, region)
            raw.sampleOnlyCoverageEnabled = true
            const before = driver.packedCoveragePasses
            if (!driver.maskAll(path, packedTargets, region) || driver.packedCoveragePasses !== before + 1) throw Error('Packed path was not selected exactly once')
            for (let phase = 0; phase < 4; phase++) {
              const a = await readBytes(referenceTargets[phase]), b = await readBytes(packedTargets[phase])
              for (let i = 0; i < a.length; i++) {
                if (a[i] !== b[i]) different++
                if (a[i] === 0) zero++; else if (a[i] === 255) occupied++
              }
              comparedBytes += a.length
            }
            if (different || !zero || !occupied) throw Error(`Packed coverage mismatch or empty oracle at ${index}/${regionIndex}: ${different}/${zero}/${occupied}`)
            record.regions.push({ regionIndex, different, zero, occupied })
          } finally {
            for (const target of [...referenceTargets, ...packedTargets]) driver.destroy(target)
          }
        }
        records.push(record)
      }
      for (const path of payload.paths) {
        const targets = Array.from({ length: 4 }, () => driver.createBinaryCoverage(path.rect.w, path.rect.h))
        try {
          driver.begin(new Float32Array(payload.scene.vertices), new Float32Array(payload.scene.curves))
          for (const packed of [false, true]) {
            raw.sampleOnlyCoverageEnabled = packed
            if (packed) driver.maskAll(path, targets)
            else for (let phase = 0; phase < 4; phase++) driver.mask(path, targets[phase], phase)
            await driver.checkpoint('timing')
          }
          for (let block = 0; block < 3; block++) for (const packed of [false, true, true, false]) {
            raw.sampleOnlyCoverageEnabled = packed
            const start = performance.now()
            if (packed) driver.maskAll(path, targets)
            else for (let phase = 0; phase < 4; phase++) driver.mask(path, targets[phase], phase)
            const encodeMs = performance.now() - start
            await driver.checkpoint('timing')
            batches.push({ header: payload.scene.curves[path.area.first * 4], block, packed, draws: packed ? 1 : 4,
              encodeMs, encodeAndQueueCompletionMs: performance.now() - start })
          }
        } finally { for (const target of targets) driver.destroy(target) }
      }
      const timings = [3, 4].map(header => {
        const rows = batches.filter(batch => batch.header === header), original = median(rows.filter(row => !row.packed).map(row => row.encodeAndQueueCompletionMs)),
          packed = median(rows.filter(row => row.packed).map(row => row.encodeAndQueueCompletionMs))
        return { header, originalMedianMs: original, packedMedianMs: packed, reduction: original ? 1 - packed / original : undefined }
      })
      return { status: 'passed', adapter: driver.stats().adapter, nonFallbackAdapterVerified: true, comparedBytes, different: 0,
        records, batches, timings, scope: payload.manifest.scope }
    } catch (error) {
      return { status: 'failed', error: String(error), stack: error instanceof Error ? error.stack : undefined, records, batches }
    } finally { driver.dispose() }
  }, { scene, paths: selected, manifest }))
  await proof.write('gpu-result.json', result)
  if (result.status !== 'passed') throw Error(result.error || 'Packed coverage GPU oracle failed')
  return { ...manifest, ...result }
})
