import { initializeKernelModule } from '../../frontend/design-client/src/kernel/module'
import { rational_tent_kernel_rgba, rational_large_tent_kernel_rgba, rational_box_kernel_rgba } from '../../frontend/design-client/src/generated/design-kernel/design_kernel'
import { WebGpuDriver } from '../../frontend/design-client/src/kernel/gpu/webgpu'
import { exactFilterPacketLayout } from '../../frontend/design-client/src/kernel/gpu/exact-filter-packet-layout'
import { parameters, type GpuScene, type Texture } from '../../frontend/design-client/src/kernel/gpu/types'

const report: any = { status: 'running', scope: 'Same rational packet, dual-axis Metal operator; exact scalar reference. No downsampling. Not whole-app latency.', cases: [], timings: [] }
async function publish() { document.querySelector('#result')!.textContent = JSON.stringify(report, null, 2); await fetch('/report', { method: 'POST', body: JSON.stringify(report) }) }
const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]
const encode = (v: number) => { v = Math.max(0, Math.min(1, v)); return v <= .0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - .055 }
export function difference(a: Float32Array, b: Float32Array) {
  let maxFloat = 0, maxEncoded = 0, maxAlpha = 0, changedBits = 0, nonfinite = 0
  const aa = new Uint32Array(a.buffer, a.byteOffset, a.length), bb = new Uint32Array(b.buffer, b.byteOffset, b.length)
  for (let i = 0; i < a.length; i++) {
    if (aa[i] !== bb[i]) changedBits++
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) { if (aa[i] !== bb[i]) nonfinite++; continue }
    maxFloat = Math.max(maxFloat, Math.abs(a[i] - b[i]))
    if (i % 4 === 3) maxAlpha = Math.max(maxAlpha, Math.abs(a[i] - b[i]))
    else for (const background of [0, 1]) {
      const alpha = i - i % 4 + 3
      maxEncoded = Math.max(maxEncoded, Math.abs(encode(a[i] + background * (1 - a[alpha])) - encode(b[i] + background * (1 - b[alpha]))))
    }
  }
  return { maxFloat, maxEncoded, maxAlpha, changedBits, nonfinite }
}
function pixels(kind: string, w: number, h: number) {
  const data = new Float32Array(w * h * 4), words = new Uint32Array(data.buffer)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const at = (y * w + x) * 4, alpha = kind === 'transparent' ? ((x * 7 + y * 13) % 17) / 16 : 1
    for (let c = 0; c < 4; c++) {
      const value = c === 3 ? alpha : kind === 'impulse' ? Number(x === (w >> 1) && y === (h >> 1)) : kind === 'checker' ? (x + y + c) % 2 : ((x * 37 + y * 13 + c * 19) % 251) / 250
      data[at + c] = c === 3 ? value : value * alpha
      if (kind === 'negative') data[at + c] = -1 - value * 3
      if (kind === 'max') words[at + c] = 0x7f7fffff
      if (kind === 'cancellation') words[at + c] = x === (w >> 1) ? 0x7effffff : 0xff7fffff
      if (kind === 'nonfinite') words[at + c] = x % 3 ? 0x7f800000 : 0x7fc01234
    }
  }
  return data
}
try {
  await initializeKernelModule()
  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter || adapter.info.isFallbackAdapter) throw Error('Hardware adapter required')
  report.adapter = { vendor: adapter.info.vendor, architecture: adapter.info.architecture, fallback: adapter.info.isFallbackAdapter }
  const driver = await WebGpuDriver.create(true, false, true, true, false)
  async function run(input: Float32Array, w: number, h: number, radius: number, clamp: boolean, candidate: boolean, hdr = false, kernelKind = 'tent', channels = 15, scalar = false, origin = [-13, 27]) {
    driver.hdr = hdr
    await driver.prepareScene({ nodes: {}, integratedBlur: true, canvasBlurApproximation: candidate } as unknown as GpuScene, true)
    await driver.prepareFilters(false)
    driver.begin(new Float32Array())
    const owned: Texture[] = [], own = (t: Texture) => { owned.push(t); return t }
    try {
      const finite = input.every(Number.isFinite)
      const source = own(finite ? driver.uploadLinear(input, w, h) : driver.create(w, h)), horizontal = own(scalar ? driver.createScalarCoverage(w, h) : driver.create(w, h)), output = own(scalar ? driver.createScalarCoverage(w, h) : driver.create(w, h))
      // Test-only malformed GPU intermediates: public uploads correctly reject
      // NaN/Inf, but a prior arithmetic shader can still produce them.
      if (!finite) (driver as any).device.queue.writeTexture({ texture: source.resource }, input,
        { bytesPerRow: w * 16, rowsPerImage: h }, [w, h])
      const bytes = kernelKind === 'box' ? rational_box_kernel_rgba(radius) : radius > 2048 ? rational_large_tent_kernel_rgba(radius) : rational_tent_kernel_rgba(radius)
      const layout = radius > 2048 ? exactFilterPacketLayout(bytes.length / 4, driver.boundedShadowPacketMaxDimension!) : undefined
      const kernel = own(layout ? driver.uploadBoundedShadowKernel(bytes, layout.width, layout.height, radius) : driver.uploadRgba8(bytes, bytes.length / 4, 1))
      const rect = { x: origin[0], y: origin[1], w, h }
      const start = performance.now()
      for (const axis of [0, 1]) {
        const u = parameters(rect, rect, { x: 0, y: 0, w: kernel.width, h: 1 }); u[16] = 22; u.set([radius, axis, Number(clamp), kernelKind === 'box' ? 2 : 1], 36)
        driver.pass(axis ? output : horizontal, u, [axis ? horizontal : source, kernel], undefined, channels, kernelKind === 'box' ? undefined : { kind: 'tent', radius })
      }
      const result = await driver.finish(output, rect, w, h, true, undefined, false, rect)
      if (!result.linear) throw Error('Missing f32 output')
      return { values: result.linear, wallMs: performance.now() - start, passes: driver.canvasBlurPasses, draws: driver.drawCalls }
    } finally { for (const t of owned) driver.destroy(t) }
  }
  try {
    const radii = [.1, .3, 1, 3.25, 31.999, 32 + 2 ** -30, 38.25948715209961, 64, 256.5, 612.1517944335938, 1177.215, 2048]
    for (const radius of radii) for (const kind of ['impulse', 'checker', 'gradient', 'transparent']) for (const clamp of [false, true]) {
      report.current = { radius, kind, clamp }; await publish()
      const w = 65, h = 17, input = pixels(kind, w, h)
      const a = await run(input, w, h, radius, clamp, false), b = await run(input, w, h, radius, clamp, true)
      const diff = difference(a.values, b.values)
      if (!a.values.some(v => v > 0) || !b.values.some(v => v > 0)) throw Error('Empty operator output')
      report.cases.push({ radius, kind, clamp, ...diff, passes: b.passes })
      if (b.passes !== 2 || diff.nonfinite || diff.maxEncoded >= 1 / 255 || diff.maxAlpha >= 1 / 255) throw Error('Numerical gate failed')
    }
    for (const radius of [1, 3, 9, 37, 38, 64, 256, 512]) for (const kind of ['impulse', 'checker', 'gradient', 'transparent']) for (const clamp of [false, true]) {
      report.current = { radius, kind, clamp, kernel: 'box' }; await publish()
      const w = 65, h = 17, input = pixels(kind, w, h)
      const a = await run(input, w, h, radius, clamp, false, false, 'box'), b = await run(input, w, h, radius, clamp, true, false, 'box')
      const diff = difference(a.values, b.values)
      report.cases.push({ radius, kind, clamp, kernel: 'box', ...diff, passes: b.passes })
      if (!a.values.some(v => v > 0) || b.passes !== 2 || diff.nonfinite || diff.maxEncoded >= 1 / 255 || diff.maxAlpha >= 1 / 255) throw Error('Box numerical gate failed')
    }
    for (const scalar of [false, true]) for (const radius of [1, 4.25, 16, 64, 256.5, 2240, 2240.125, 4096]) for (const origin of [[-13,27],[.25,-.375]]) {
      const w=65,h=17,input=pixels('transparent',w,h)
      const a=await run(input,w,h,radius,false,false,false,'tent',8,scalar,origin),b=await run(input,w,h,radius,false,true,false,'tent',8,scalar,origin)
      const diff=difference(a.values,b.values)
      report.cases.push({kind:'shadow-alpha',radius,scalar,origin,...diff,passes:b.passes})
      if(b.passes!==2||diff.nonfinite||diff.maxEncoded>=1/255||diff.maxAlpha>=1/255)throw Error('Alpha numerical gate failed')
    }
    for (const kernelKind of ['tent', 'box']) for (const kind of ['negative', 'max', 'cancellation', 'nonfinite']) for (const radius of kernelKind === 'box' ? [1, 9] : [1, 38.25948715209961]) {
      const w = 17, h = 9, input = pixels(kind, w, h)
      const a = await run(input, w, h, radius, true, false, false, kernelKind), b = await run(input, w, h, radius, true, true, false, kernelKind)
      const diff = difference(a.values, b.values)
      report.cases.push({ radius, kind, kernelKind, clamp: true, ...diff, passes: b.passes, exactFallback: true })
      if (diff.changedBits) throw Error('Exact fallback changed bits: ' + kind)
    }
    {
      const input = pixels('gradient', 17, 9), a = await run(input, 17, 9, 38.25, true, false, true), b = await run(input, 17, 9, 38.25, true, true, true)
      const diff = difference(a.values, b.values); report.cases.push({ kind: 'hdr', ...diff, passes: b.passes })
      if (diff.changedBits || b.passes) throw Error('HDR path changed')
    }
    for (const [radius, kernelKind] of [[38.25948715209961, 'tent'], [256.5, 'tent'], [612.1517944335938, 'tent'], [9, 'box'], [38, 'box'], [91, 'box'], [16, 'alpha'], [64, 'alpha']] as const) {
      const input = pixels('transparent', 128, 32), times: number[][] = [[], []]
      for (let round = 0; round < 4; round++) for (const side of round % 2 ? [1, 0] : [0, 1]) {
        const r = await run(input, 128, 32, radius, false, !!side, false, kernelKind === 'alpha' ? 'tent' : kernelKind, kernelKind === 'alpha' ? 8 : 15, kernelKind === 'alpha')
        if (round) times[side].push(r.wallMs)
      }
      const controlMs = median(times[0]), candidateMs = median(times[1])
      report.timings.push({ radius, kernelKind, times, controlMs, candidateMs, improvement: 1 - candidateMs / controlMs }); await publish()
    }
    report.status = report.timings.every((r: any) => r.improvement >= .2) ? 'passed' : 'performance-failed'
  } finally { driver.dispose() }
} catch (error) { report.status = 'failed'; report.error = String(error); report.stack = error instanceof Error ? error.stack : undefined }
await publish()
