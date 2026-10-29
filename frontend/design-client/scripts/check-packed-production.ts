import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { initSync, VectorEngine } from '../src/generated/design-kernel/design_kernel.js'
import { project, runProof, sha256 } from './exact-prefix-proof-utils'

const documentPath = process.env.DESIGN_COVERAGE_DOCUMENT, requestsPath = process.env.DESIGN_COVERAGE_REQUESTS
if (!documentPath || !requestsPath || process.env.VITE_DESIGN_SAMPLE_ONLY_COVERAGE !== '1' || process.env.VITE_DESIGN_PACKED_COVERAGE !== '1')
  throw Error('Supply actual document/requests and both strict coverage build gates')
await runProof('futureox-packed-production', [resolve(documentPath), resolve(requestsPath)], async proof => {
  const [documentBytes, requestBytes, wasm, font] = await Promise.all([readFile(documentPath), readFile(requestsPath),
    readFile(join(project, 'public/kernel/design_kernel_bg.wasm')), readFile(join(project, 'public/fonts/NotoSansSC.ttf'))])
  const request = JSON.parse(requestBytes.toString())[0]
  initSync({ module: wasm })
  const engine = new VectorEngine(); let native: string
  try { engine.load_font(font); engine.load_document(documentBytes.toString()); native = engine.compile_gpu(JSON.stringify(request)) }
  finally { engine.free() }
  const scene = JSON.parse(native!)
  const manifest = { documentSha256: sha256(documentBytes), requestsSha256: sha256(requestBytes), nativeSceneSha256: sha256(native!),
    wasmSha256: sha256(wasm), fontSha256: sha256(font), nodes: Object.keys(scene.nodes).length,
    scope: 'Production GpuRenderer display presentation and returned ImageBitmap; same source private packed toggle; paired warm wall time including production graph and queue completion, not physical scanout or input latency.' }
  await proof.write('fixtures.json', manifest)
  if (proof.prepareOnly) return manifest
  const result = await proof.browser(async page => page.evaluate(async payload => {
    const { initializeKernelModule } = await import('/src/kernel/module.ts')
    const { WebGpuDriver } = await import('/src/kernel/gpu/webgpu.ts')
    const { GpuRenderer } = await import('/src/kernel/gpu/renderer.ts')
    await initializeKernelModule()
    const pair: any[] = []
    for (const candidate of [false, true]) {
      const managed = !!(payload.scene.floatCompositing || payload.scene.colorManagement)
      const driver = await WebGpuDriver.create(managed, false, !!payload.scene.colorManagement, true, false), raw = driver as any
      raw.packedCoverageEnabled = candidate
      if (driver.device.adapterInfo.isFallbackAdapter !== false) throw Error('Confirmed non-fallback GPU required')
      pair.push({ driver, raw, renderer: new GpuRenderer(driver, true, false) })
    }
    const scene = () => { const value = structuredClone(payload.scene); value.vertices = new Float32Array(value.vertices); value.curves = new Float32Array(value.curves); return value }
    const capture = async (side: number) => {
      const { raw, renderer } = pair[side], start = performance.now(), stats = await renderer.render(scene(), false, true)
      const wallMs = performance.now() - start, bitmap = stats.bitmap
      if (!bitmap) throw Error('Production render returned no display bitmap')
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d')!
      context.drawImage(bitmap, 0, 0); const bytes = context.getImageData(0, 0, bitmap.width, bitmap.height).data.slice(); bitmap.close()
      return { wallMs, bytes, stats, packedPasses: raw.packedCoveragePasses }
    }
    const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2 }
    try {
      const cold = [await capture(0), await capture(1)]
      for (let warm = 0; warm < 2; warm++) for (const side of [0, 1]) await capture(side)
      const outputs = [await capture(0), await capture(1)]
      let differences = 0, nonuniform = 0
      for (let i = 0; i < outputs[0].bytes.length; i++) {
        if (outputs[0].bytes[i] !== outputs[1].bytes[i]) differences++
        if (i % 4 === 0 && (outputs[0].bytes[i] !== outputs[0].bytes[0] || outputs[0].bytes[i + 1] !== outputs[0].bytes[1] || outputs[0].bytes[i + 2] !== outputs[0].bytes[2])) nonuniform++
      }
      if (differences || !nonuniform) throw Error(`Production pixel mismatch or empty oracle: ${differences}/${nonuniform}`)
      if (outputs[0].packedPasses !== 0 || outputs[1].packedPasses <= 0) throw Error(`Production packed routing missing: ${outputs[0].packedPasses}/${outputs[1].packedPasses}`)
      const runs: any[][] = [[], []]
      for (let repetition = 0; repetition < 3; repetition++) for (const side of repetition % 2 ? [1, 0] : [0, 1]) {
        const result = await capture(side)
        runs[side].push({ wallMs: result.wallMs, packedPasses: result.packedPasses, drawCalls: result.stats.drawCalls })
      }
      const controlMs = median(runs[0].map(row => row.wallMs)), candidateMs = median(runs[1].map(row => row.wallMs))
      return { status: 'passed', adapter: pair[0].driver.stats().adapter, nonFallbackAdapterVerified: true,
        comparedBytes: outputs[0].bytes.length, differences, nonuniform, cold: cold.map(row => ({ wallMs: row.wallMs, packedPasses: row.packedPasses })),
        controlPackedPasses: outputs[0].packedPasses, candidatePackedPasses: outputs[1].packedPasses,
        runs, controlMs, candidateMs, improvement: 1 - candidateMs / controlMs, scope: payload.manifest.scope }
    } finally { for (const entry of pair) entry.renderer.dispose() }
  }, { scene, manifest }))
  await proof.write('gpu-result.json', result)
  if (result.status !== 'passed') throw Error(result.error || 'Packed production GPU oracle failed')
  return { ...manifest, ...result }
})
