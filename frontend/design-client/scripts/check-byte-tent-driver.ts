/** Actual-device gate for the production driver's default-off byte-alpha API.
 * The full32-case module oracle remains separate. This gate exercises owned
 * production textures, encoder submission/abandonment, and covered ledgers.
 * It is not a real FIG motion, latency, undo or export acceptance result. */
import { byteTentOracle, byteTentRationalOracle, planByteTentPrefix, type ByteTentRect } from '../src/kernel/gpu/byte-tent-prefix-plan'
import { runProof, sha256 } from './exact-prefix-proof-utils'

type Fixture = { name: string; radius: number; axis: 0 | 1; source: ByteTentRect; output: ByteTentRect;
  alpha: number[]; both?: boolean; scratchBudgetBytes?: number; boundary?: 'checkpoint' | 'finish' }
let seed = 0x117f19
const random = (length: number) => Array.from({ length }, () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 24
})
function imageOracle(alpha: number[], source: ByteTentRect, output: ByteTentRect, axis: 0 | 1, radius: number,
  oracle: typeof byteTentOracle) {
  const result: number[] = []
  for (let y = 0; y < output.h; y++) for (let x = 0; x < output.w; x++) {
    const cross = axis === 0 ? output.y + y - source.y : output.x + x - source.x
    const length = axis === 0 ? source.w : source.h, crossLength = axis === 0 ? source.h : source.w
    const line = Array.from({ length }, (_, at) => cross < 0 || cross >= crossLength ? 0 :
      axis === 0 ? alpha[cross * source.w + at] : alpha[at * source.w + cross])
    const center = axis === 0 ? output.x + x - source.x : output.y + y - source.y
    result.push(oracle(line, center, radius))
  }
  return result
}
function prepare(f: Fixture, index: number) {
  const intermediate = f.both ? { x: f.output.x, y: f.source.y, w: f.output.w, h: f.source.h } : f.output
  const first = imageOracle(f.alpha, f.source, intermediate, f.axis, f.radius, byteTentOracle)
  const other = imageOracle(f.alpha, f.source, intermediate, f.axis, f.radius, byteTentRationalOracle)
  if (first.some((value, at) => value !== other[at])) throw Error(`First-axis independent rational disagreement: ${f.name}`)
  const final = f.both ? imageOracle(first, intermediate, f.output, 1, f.radius, byteTentOracle) : first
  const otherFinal = f.both ? imageOracle(other, intermediate, f.output, 1, f.radius, byteTentRationalOracle) : other
  if (final.some((value, at) => value !== otherFinal[at])) throw Error(`Second-axis independent rational disagreement: ${f.name}`)
  const p = planByteTentPrefix({ radius: f.radius, axis: f.axis, source: f.source, output: intermediate, scratchBudgetBytes: f.scratchBudgetBytes })
  if (!p) throw Error(`Fixture plan rejected: ${f.name}`)
  return { ...f, intermediate, first, final, firstPlan: { bytes: p.bytes, bands: p.bands, bandLines: p.bandLines },
    boundary: f.boundary || (index % 2 ? 'finish' : 'checkpoint') as 'checkpoint' | 'finish' }
}

await runProof('futureox-byte-tent-driver', [], async proof => {
  const fixtures: Fixture[] = []
  for (const [radius, axis] of [[1, 0], [31, 1], [512, 0]] as const) {
    const length = Math.max(7, radius * 2 + 1)
    const source = { x: -26000, y: 17000, w: axis === 0 ? length : 3, h: axis === 0 ? 3 : length }
    fixtures.push({ name: `production-r${radius}-axis${axis}-cross-edge`, radius, axis, source,
      output: { x: source.x + (axis === 0 ? radius - 2 : -1), y: source.y + (axis === 1 ? radius - 2 : -1),
        w: axis === 0 ? 7 : 5, h: axis === 1 ? 7 : 5 }, alpha: random(source.w * source.h) })
  }
  for (const [radius, axis] of [[1920, 0], [2048, 1]] as const) {
    const length = radius * 2 + 1
    const source = { x: -26000, y: 17000, w: axis === 0 ? length : 3, h: axis === 0 ? 3 : length }
    fixtures.push({ name: `production-opaque-r${radius}-axis${axis}-u32-overflow`, radius, axis, source,
      output: { x: source.x + (axis === 0 ? radius : 0), y: source.y + (axis === 1 ? radius : 0), w: 1, h: 1 },
      alpha: new Array(source.w * source.h).fill(255) })
  }
  {
    const radius = 1920, source = { x: -50000, y: -50000, w: radius * 2 + 1, h: 1 }, alpha = new Array(source.w).fill(129)
    let remaining = radius * radius / 2
    for (let k = radius - 1; k >= 1; k--) { const take = Math.min(129, Math.floor(remaining / k)); alpha[k] -= take; remaining -= take * k }
    if (remaining) throw Error('Half-tie fixture construction failed')
    fixtures.push({ name: 'production-half-tie-r1920-odd-to-even', radius, axis: 0, source,
      output: { x: source.x + radius, y: source.y, w: 1, h: 1 }, alpha })
  }
  fixtures.push({ name: 'production-two-byte-boundaries-impulse', radius: 1, axis: 0, both: true,
    source: { x: -1000, y: -1000, w: 3, h: 3 }, output: { x: -999, y: -999, w: 1, h: 1 },
    alpha: [0, 0, 0, 0, 1, 0, 0, 0, 0] })
  fixtures.push({ name: 'production-two-byte-boundaries-r31', radius: 31, axis: 0, both: true,
    source: { x: 24000, y: -15000, w: 67, h: 71 }, output: { x: 24030, y: -14970, w: 3, h: 3 }, alpha: random(67 * 71) })
  fixtures.push({ name: 'production-two-byte-boundaries-r1920', radius: 1920, axis: 0, both: true,
    source: { x: -20000, y: -30000, w: 3841, h: 5 }, output: { x: -18080, y: -29999, w: 3, h: 3 },
    alpha: new Array(3841 * 5).fill(255) })
  fixtures.push({ name: 'production-transparent-along-edge-r2048', radius: 2048, axis: 0,
    source: { x: -1040000, y: 17000, w: 4097, h: 3 }, output: { x: -1040003, y: 16999, w: 3, h: 5 },
    alpha: new Array(4097 * 3).fill(255) })
  fixtures.push({ name: 'production-finite-budget-partial-band-r2048', radius: 2048, axis: 0, scratchBudgetBytes: 350000,
    source: { x: -30000, y: -30000, w: 4097, h: 17 }, output: { x: -27954, y: -30000, w: 7, h: 17 },
    alpha: random(4097 * 17) })
  const prepared = fixtures.map(prepare)
  const cancelRect = { x: 0, y: 0, w: 17, h: 3 }, cancelAlpha = Array.from({ length: 17 * 3 }, (_, at) => ((at * 4 + 3) * 13) & 255)
  const cancelExpected = imageOracle(cancelAlpha, cancelRect, cancelRect, 0, 1920, byteTentOracle)
  const cancelRational = imageOracle(cancelAlpha, cancelRect, cancelRect, 0, 1920, byteTentRationalOracle)
  if (cancelExpected.some((value, at) => value !== cancelRational[at])) throw Error('Independent recovery/cancel oracles disagree')
  const summary = prepared.map(f => ({ name: f.name, radius: f.radius, axis: f.axis, source: f.source, output: f.output,
    both: !!f.both, boundary: f.boundary, firstPlan: f.firstPlan, sourceAlphaSha256: sha256(new Uint8Array(f.alpha)),
    firstSha256: sha256(new Uint8Array(f.first)), finalSha256: sha256(new Uint8Array(f.final)),
    ...(f.name.includes('u32-overflow') ? { exactFullFootprintNumerator: String(6n * BigInt(f.radius) ** 2n * 255n) } : {}) }))
  await proof.write('fixtures.json', { summary, cancelAlphaSha256: sha256(new Uint8Array(cancelAlpha)),
    cancelExpectedSha256: sha256(new Uint8Array(cancelExpected)), candidate: 'Production WebGpuDriver.prepareByteTent/encodeByteTentAlpha',
    scope: 'Driver-owned native RGBA8 alpha pixels and real encoder/lease boundaries. Two independent CPU models supply expectations; the separate module32 proof retains its <=512 unchanged-old-GPU comparison. No old GPU result exists above512. Not FIG whole-app acceptance.' })
  if (proof.prepareOnly) return { gpuExecuted: false, cases: summary.length, independentCpuOraclesAgree: true,
    scope: 'Prepared only: no adapter, WebGpuDriver, GPU pixel or lifecycle execution occurred' }
  if (process.env.VITE_DESIGN_BYTE_TENT_PREFIX !== '1' || process.env.VITE_DESIGN_EXACT_CLAMP_PREFIX !== '1')
    throw Error('Actual driver proof requires both strict VITE_DESIGN_BYTE_TENT_PREFIX=1 and VITE_DESIGN_EXACT_CLAMP_PREFIX=1')
  const result = await proof.browser(async page => {
    let progress = 0
    await page.exposeFunction('byteDriverProgress', (value: unknown) => proof.write(`progress-${String(++progress).padStart(3, '0')}.json`, value))
    return page.evaluate(async ({ fixtures, cancelExpected }) => {
      const { WebGpuDriver } = await import('/src/kernel/gpu/webgpu.ts')
      const { planByteTentPrefix } = await import('/src/kernel/gpu/byte-tent-prefix-plan.ts')
      const report = (value: unknown) => (globalThis as any).byteDriverProgress(value) as Promise<void>
      if (!navigator.gpu) throw Error('Actual WebGPU API missing')
      const gpu = navigator.gpu, requestAdapter = gpu.requestAdapter, previousDescriptor = Object.getOwnPropertyDescriptor(gpu, 'requestAdapter')
      let adapterInfo: Record<string, unknown> | undefined
      // Observe the actual production-factory request and return its unchanged
      // native adapter, rather than claiming a separate probe is that device.
      Object.defineProperty(gpu, 'requestAdapter', { configurable: true, value: async (options: GPURequestAdapterOptions) => {
        const adapter = await requestAdapter.call(gpu, options)
        if (!adapter || adapter.info.isFallbackAdapter !== false) throw Error('Confirmed non-fallback production adapter required')
        adapterInfo = { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device,
          description: adapter.info.description, isFallbackAdapter: adapter.info.isFallbackAdapter,
          maxTextureDimension2D: adapter.limits.maxTextureDimension2D }
        return adapter
      } })
      let driver: Awaited<ReturnType<typeof WebGpuDriver.create>>
      try { driver = await WebGpuDriver.create(false, false, false, false, false) }
      finally {
        if (previousDescriptor) Object.defineProperty(gpu, 'requestAdapter', previousDescriptor)
        else delete (gpu as any).requestAdapter
      }
      if (!adapterInfo) throw Error('Production adapter identity was not observed')
      const internal = driver as any
      const device = internal.device as GPUDevice, failures: string[] = [], records: any[] = []
      device.addEventListener('uncapturederror', event => failures.push(event.error.message))
      const digest = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
        .map(value => value.toString(16).padStart(2, '0')).join('')
      let bytesCompared = 0, maxScratchBytes = 0, stage = 'prepare-driver'
      const state = () => ({ scratchBytes: driver.scratchBytes, leaseCount: internal.byteTentLeases.size,
        byteTentAlphaPasses: driver.byteTentAlphaPasses, resourceEpoch: driver.resourceEpoch, completedResourceEpoch: driver.completedResourceEpoch })
      const read = (target: any) => {
        const stride = Math.ceil(target.width * 4 / 256) * 256
        const buffer = device.createBuffer({ size: stride * target.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
        internal.encoder.copyTextureToBuffer({ texture: target.resource }, { buffer, bytesPerRow: stride }, [target.width, target.height])
        return { buffer, stride, width: target.width, height: target.height }
      }
      const mapped = async (input: ReturnType<typeof read>) => {
        await input.buffer.mapAsync(GPUMapMode.READ)
        const raw = new Uint8Array(input.buffer.getMappedRange()), packed = new Uint8Array(input.width * input.height * 4)
        for (let y = 0; y < input.height; y++) packed.set(raw.subarray(y * input.stride, y * input.stride + input.width * 4), y * input.width * 4)
        input.buffer.unmap(); input.buffer.destroy(); return packed
      }
      const verify = async (input: ReturnType<typeof read>, expected: number[], name: string) => {
        const actual = await mapped(input)
        for (let i = 0; i < actual.length; i++) if (actual[i] !== (i % 4 === 3 ? expected[i >>> 2] : 0))
          throw Error(`${name} raw mismatch at byte${i}: ${actual[i]} != ${i % 4 === 3 ? expected[i >>> 2] : 0}`)
        bytesCompared += actual.length; return digest(actual)
      }
      const upload = (f: any) => {
        const pixels = new Uint8Array(f.source.w * f.source.h * 4)
        f.alpha.forEach((value: number, at: number) => { pixels[at * 4] = (at * 17) & 255; pixels[at * 4 + 1] = 99; pixels[at * 4 + 3] = value })
        return driver.uploadRgba8(pixels, f.source.w, f.source.h)
      }
      const encode = (target: any, source: any, f: any, sourceRect: any, output: any, axis: 0 | 1) => {
        const options = { radius: f.radius, axis, source: sourceRect, output, scratchBudgetBytes: f.scratchBudgetBytes }
        const plan = planByteTentPrefix(options)
        if (!plan || !driver.encodeByteTentAlpha(target, source, options, 4 * 1024 * 1024 - driver.scratchBytes))
          throw Error(`Production driver declined admitted ${f.name}`)
        return plan.bytes
      }
      try {
        if (!await driver.prepareByteTent() || driver.scratchBytes) throw Error('Production pipeline preparation failed or allocated hidden scratch')
        for (const f of fixtures) {
          stage = f.name; driver.begin(new Float32Array(0))
          const source = upload(f), first = driver.create(f.intermediate.w, f.intermediate.h)
          const output = f.both ? driver.create(f.output.w, f.output.h) : first
          let expectedScratch = encode(first, source, f, f.source, f.intermediate, f.axis)
          const firstRead = read(first)
          if (f.both) expectedScratch += encode(output, first, f, f.intermediate, f.output, 1)
          const finalRead = f.both ? read(output) : undefined
          const before = state(), expectedLeases = f.both ? 2 : 1
          if (before.scratchBytes !== expectedScratch || before.leaseCount !== expectedLeases || expectedScratch > 4 * 1024 * 1024)
            throw Error('Production scratch/lease ledger did not include every encoded job')
          maxScratchBytes = Math.max(maxScratchBytes, before.scratchBytes)
          const boundary = f.boundary === 'checkpoint' ? driver.checkpoint('checkpoint') :
            driver.finish(output, f.output, f.output.w, f.output.h, false, undefined, false)
          const inFlight = state()
          if (inFlight.scratchBytes !== before.scratchBytes || inFlight.leaseCount !== before.leaseCount)
            throw Error('A submission acknowledgement reclaimed scratch before covered completion')
          await boundary
          const after = state()
          if (after.scratchBytes || after.leaseCount) throw Error('A successful covered boundary retained byte scratch')
          const firstSha256 = await verify(firstRead, f.first, f.name + '/first')
          const finalSha256 = finalRead ? await verify(finalRead, f.final, f.name + '/final') : firstSha256
          if (f.boundary === 'checkpoint') await driver.finish(output, f.output, f.output.w, f.output.h, false, undefined, false)
          for (const target of new Set([source, first, output])) driver.destroy(target)
          records.push({ name: f.name, boundary: f.boundary, both: !!f.both, different: 0, firstSha256, finalSha256,
            firstPlan: f.firstPlan, before, inFlight, after, cpuOracles: 2, uploadedAndReadback: 'actual-owned-rgba8unorm' })
          await report({ stage: 'case-passed', record: records.at(-1), completedCases: records.length, bytesCompared })
        }
        stage = 'decline-no-side-effects'; driver.begin(new Float32Array(0))
        const rect = { x: 0, y: 0, w: 17, h: 3 }, sentinel = Uint8Array.from({ length: 17 * 3 * 4 }, (_, at) => at * 13 & 255)
        const source = driver.uploadRgba8(sentinel, 17, 3), target = driver.uploadRgba8(sentinel, 17, 3)
        const wrongFormat = driver.uploadParameters(new Float32Array(17 * 3 * 4), 17, 3)
        const p = { radius: 1920, axis: 0 as const, source: rect, output: rect }, plan = planByteTentPrefix(p)!
        const before = state(), encoder = internal.encoder
        const declines = [driver.encodeByteTentAlpha(target, { ...source }, p, plan.bytes),
          driver.encodeByteTentAlpha(target, wrongFormat, p, plan.bytes), driver.encodeByteTentAlpha(source, source, p, plan.bytes),
          driver.encodeByteTentAlpha(target, source, p, plan.bytes - 1),
          driver.encodeByteTentAlpha(target, source, { ...p, radius: 1920.25 }, plan.bytes)]
        if (declines.some(Boolean) || internal.encoder !== encoder || JSON.stringify(state()) !== JSON.stringify(before))
          throw Error('Declined production request changed its encoder or accounting')
        const sentinelRead = read(target); await driver.checkpoint('checkpoint')
        const unchanged = await mapped(sentinelRead)
        if (unchanged.some((byte, at) => byte !== sentinel[at])) throw Error('Declined API request changed target pixels')
        await driver.finish(target, rect, 17, 3, false, undefined, false)
        const negative = { cases: declines.length, sideEffects: 0, unchangedTargetSha256: await digest(unchanged) }

        stage = 'unsubmitted-cancel'; driver.begin(new Float32Array(0))
        if (!driver.encodeByteTentAlpha(target, source, p, plan.bytes)) throw Error('Cancel fixture declined')
        const unsubmittedBefore = state(), abandoned = internal.encoder
        const cancellation = driver.abortFrameAndReleaseFilterScratch('cancel'), abandonedState = state()
        if (abandonedState.scratchBytes || abandonedState.leaseCount || internal.encoder === abandoned)
          throw Error('Unsubmitted cancellation retained its abandoned job or encoder')
        await cancellation
        const preserved = read(target); await driver.checkpoint('checkpoint')
        const preservedPixels = await mapped(preserved)
        if (preservedPixels.some((byte, at) => byte !== sentinel[at])) throw Error('Abandoned encoder was submitted or changed target pixels')
        const unsubmitted = { before: unsubmittedBefore, afterAbandon: abandonedState, afterCovered: state(),
          targetUnchangedSha256: await digest(preservedPixels) }

        stage = 'restart-and-submitted-cancel'; driver.begin(new Float32Array(0))
        if (!driver.encodeByteTentAlpha(target, source, p, plan.bytes)) throw Error('Restarted frame could not encode')
        const outputRead = read(target); driver.submitPending()
        const submittedBefore = state(), coveredCancel = driver.abortFrameAndReleaseFilterScratch('cancel'), waitingCancel = state()
        if (!submittedBefore.scratchBytes || waitingCancel.scratchBytes !== submittedBefore.scratchBytes)
          throw Error('Submitted cancellation reclaimed before its real queue boundary')
        await coveredCancel
        if (driver.scratchBytes || internal.byteTentLeases.size) throw Error('Submitted cancel retained scratch after completion')
        // radius1920 over this short source is not zero by assumption: compute
        // expected alpha from the same independent CPU fixture models outside
        // the browser, supplied as an extra prepared recovery fixture below.
        const actualRecovery = await mapped(outputRead)
        const recoveryExpected = cancelExpected
        for (let at = 0; at < actualRecovery.length; at++) if (actualRecovery[at] !== (at % 4 === 3 ? recoveryExpected[at >>> 2] : 0))
          throw Error(`Restart/cancel raw pixel mismatch at byte${at}`)
        bytesCompared += actualRecovery.length
        const submitted = { before: submittedBefore, whileWaiting: waitingCancel, afterCovered: state(),
          outputSha256: await digest(actualRecovery), different: 0 }
        for (const texture of [source, target, wrongFormat]) driver.destroy(texture)
        await device.queue.onSubmittedWorkDone()
        if (driver.lost || failures.length) throw Error(failures.join('\n') || 'Production device lost')
        return { gpuExecuted: true, candidate: 'WebGpuDriver production API', adapter: adapterInfo,
          deviceLimits: { maxTextureDimension2D: device.limits.maxTextureDimension2D,
            maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize, maxBufferSize: device.limits.maxBufferSize }, cases: records.length, records,
          bytesCompared, different: 0, maxScratchBytes, declines: negative, unsubmittedCancel: unsubmitted,
          restartAndSubmittedCancel: submitted, finalLedger: state(), deviceStats: driver.stats(),
          scope: 'Actual GPU pixel and production-driver lifecycle gate only; not actual FIG whole-app latency or quality acceptance' }
      } catch (error) {
        await report({ stage, error: String(error), completedCases: records.length, records, ledger: state() })
        throw error
      } finally { internal.poolKey = undefined; driver.dispose() }
    }, { fixtures: prepared, cancelExpected })
  })
  await proof.write('gpu-result.json', result)
  return result
})
