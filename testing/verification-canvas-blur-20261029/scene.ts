import { initializeKernelModule } from '../../frontend/design-client/src/kernel/module'
import { VectorEngine } from '../../frontend/design-client/src/generated/design-kernel/design_kernel'
import { WebGpuDriver } from '../../frontend/design-client/src/kernel/gpu/webgpu'
import { GpuRenderer } from '../../frontend/design-client/src/kernel/gpu/renderer'
import { managedSceneImageLoader } from '../../frontend/design-client/src/kernel/scene-image-hydration'
import { DecodedImageCache, createDecodedImageOwner, decodedImageScope } from '../../frontend/design-client/src/kernel/decoded-image-cache'

const profiling = import.meta.env.VITE_DESIGN_GPU_TIMINGS === '1'
const report: any = { profiling, status: 'running', cases: [], timings: [], scope: 'Actual 117/FIG packets, production display graph, same source toggle. Test-only final float readback; no input latency/FPS claim.' }
async function publish() { document.querySelector('#result')!.textContent = JSON.stringify(report, null, 2); await fetch('/report', { method: 'POST', body: JSON.stringify(report) }) }
const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]
const encode = (v: number) => { v = Math.max(0, Math.min(1, v)); return v <= .0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - .055 }
function difference(a: Float32Array, b: Float32Array, linear: boolean) {
  let changedBits = 0, maxEncoded = 0, maxAlpha = 0, nonfinite = 0
  const aa = new Uint32Array(a.buffer, a.byteOffset, a.length), bb = new Uint32Array(b.buffer, b.byteOffset, b.length), toScreen = linear ? encode : (v: number) => Math.min(1, Math.max(0, v))
  for (let i = 0; i < a.length; i++) {
    if (aa[i] !== bb[i]) changedBits++
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) { if (aa[i] !== bb[i]) nonfinite++; continue }
    if (i % 4 === 3) maxAlpha = Math.max(maxAlpha, Math.abs(a[i] - b[i]))
    else for (const background of [0, 1]) {
      const alpha = i - i % 4 + 3
      maxEncoded = Math.max(maxEncoded, Math.abs(toScreen(a[i] + background * (1 - a[alpha])) - toScreen(b[i] + background * (1 - b[alpha]))))
    }
  }
  return { changedBits, maxEncoded, maxAlpha, nonfinite }
}
function preview(values: Float32Array, width: number, height: number, linear: boolean, label: string) {
  const section = document.createElement('div'); section.textContent = label
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; section.append(canvas)
  document.querySelector('#previews')!.append(section)
  const bytes = new Uint8ClampedArray(values.length)
  for (let i = 0; i < values.length; i += 4) {
    for (let c = 0; c < 3; c++) { const value = values[i + c] + 1 - values[i + 3]; bytes[i + c] = Math.round((linear ? encode(value) : Math.max(0, Math.min(1, value))) * 255) }
    bytes[i + 3] = 255
  }
  canvas.getContext('2d')!.putImageData(new ImageData(bytes, width, height), 0, 0)
}
try {
  await initializeKernelModule()
  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter || adapter.info.isFallbackAdapter) throw Error('Hardware required')
  report.adapter = { vendor: adapter.info.vendor, architecture: adapter.info.architecture, fallback: adapter.info.isFallbackAdapter }
  const manifest = await (await fetch('/real-inputs/manifest.json')).json(); report.sources = manifest
  const font = new Uint8Array(await (await fetch('/fonts/NotoSansSC.ttf')).arrayBuffer())
  for (const name of profiling ? ['117-detail', '117-zoom400'] : ['117-overview', '117-detail', '117-zoom400', '117-zoom950', 'fig-cards']) {
    report.current = name; await publish()
    const sourceName = name.startsWith('117') ? '117' : 'fig', serialized = await (await fetch(`/real-inputs/${sourceName}.json`)).text()
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized)))].map(v => v.toString(16).padStart(2, '0')).join('')
    if (hash !== manifest.find((r: any) => r.name === sourceName)?.documentSha256) throw Error('Source hash mismatch')
    const doc = JSON.parse(serialized), kernel = new VectorEngine(); kernel.load_font(font); kernel.load_document(serialized)
    const board = doc.pages.flatMap((p: any) => p.children.map((id: string) => doc.nodes[id])).find((n: any) => n?.name === (sourceName === '117' ? '117' : '01_Dashboard') && n.kind === 'frame')
    if (!board) throw Error('Missing board')
    const pageId = doc.pages.find((p: any) => p.children.includes(board.id)).id
    const zoom = name === '117-overview' ? .25 : name === '117-zoom400' ? 4 : name === '117-zoom950' ? 9.5 : 1
    const offset = name === '117-overview' ? [0, 0] : sourceName === '117' ? [600, 100] : [240, 50]
    const width = 256, height = 192, options = { pageId, width, height, view: { x: -(board.transform[4] + offset[0]) * zoom - .125, y: -(board.transform[5] + offset[1]) * zoom + .375, zoom }, rasterProfile: sourceName === '117' ? 'figmaSubpixel' : (doc.rasterProfile || 'analytic'), transparent: true }
    const raw = kernel.compile_gpu(JSON.stringify(options)), settings = kernel.color_settings(), owner = createDecodedImageOwner(), pair: any[] = []
    const scene = () => { const s = JSON.parse(raw); s.vertices = new Float32Array(s.vertices); s.curves = new Float32Array(s.curves); return s }
    const row: any = { name, options, packetNodes: Object.keys(JSON.parse(raw).nodes).length, integratedBlur: JSON.parse(raw).integratedBlur, runs: [[], []] }; report.cases.push(row)
    try {
      for (const enabled of [false, true]) {
        const loader = managedSceneImageLoader(new DecodedImageCache(), () => ({ kernel, scope: decodedImageScope(owner, settings), settings, current: () => true, ownerCurrent: () => true, resourceOwner: owner }), { key: async () => undefined, read: async () => undefined, write: () => {} })
        const driver = await WebGpuDriver.create(true, false, !!doc.colorManagement, true, false), renderer = new GpuRenderer(driver, true, false, loader) as any
        renderer.canvasBlurEnabled = enabled
        // Read the display graph's final texture for QA. This does not change
        // renderAttempt's production displayOnly policy or any filter pass.
        const finish = driver.finish.bind(driver)
        driver.finish = (texture, rect, w, h, _readback, presentation, present, output) => finish(texture, rect, w, h, true, presentation, present, output)
        pair.push({ renderer, driver })
      }
      const outputs: Float32Array[] = []
      for (let round = 0; round < (profiling ? 3 : 5); round++) for (const side of round % 2 ? [1, 0] : [0, 1]) {
        const start = performance.now(), result = await pair[side].renderer.render(scene(), false, true), wallMs = performance.now() - start
        if (!result.linear) throw Error('Missing display float capture')
        result.bitmap?.close()
        const run = { wallMs, graphMs: result.graphMs, finishMs: result.finishMs, draws: result.drawCalls, pixels: result.passPixels, peakBytes: result.peakTextureBytes, canvasBlurPasses: pair[side].driver.canvasBlurPasses, ...(profiling ? { gpuPassTimings: pair[side].driver.passTimings } : {}) }
        if (round === 0) (row.cold ??= [])[side] = run
        if (round === 1) outputs[side] = result.linear
        if (round >= 2) row.runs[side].push(run)
        await publish()
      }
      row.difference = difference(outputs[0], outputs[1], !!doc.colorManagement)
      if (!outputs[0].some((v, i) => i % 4 === 3 && v > .1)) throw Error('Empty real scene')
      if (row.difference.nonfinite || row.difference.maxEncoded >= 1 / 255 || row.difference.maxAlpha >= 1 / 255) throw Error('Real scene quality gate failed')
      for (const side of [0, 1]) preview(outputs[side], width, height, !!doc.colorManagement, name + (side ? ' candidate' : ' exact'))
      const exports: Float32Array[] = []
      for (const side of [0, 1]) {
        const result = await pair[side].renderer.render(scene(), true, false); exports[side] = result.linear
        if (pair[side].driver.canvasBlurPasses) throw Error('Approximation entered exact output')
      }
      row.exactOutput = difference(exports[0], exports[1], !!doc.colorManagement)
      if (row.exactOutput.changedBits) throw Error('Exact output changed after display')
      const controlMs = median(row.runs[0].map((r: any) => r.wallMs)), candidateMs = median(row.runs[1].map((r: any) => r.wallMs))
      report.timings.push({ name, controlMs, candidateMs, improvement: 1 - candidateMs / controlMs, candidatePasses: row.runs[1][0].canvasBlurPasses }); await publish()
    } finally { for (const { renderer } of pair) renderer.dispose(); kernel.free() }
  }
  if (!profiling && !report.timings.some((r: any) => r.name.startsWith('117') && r.candidatePasses > 0 && r.improvement >= .05)) throw Error('No 117 performance acceptance')
  report.status = 'passed'
} catch (error) { report.status = 'failed'; report.error = String(error); report.stack = error instanceof Error ? error.stack : undefined }
await publish()
