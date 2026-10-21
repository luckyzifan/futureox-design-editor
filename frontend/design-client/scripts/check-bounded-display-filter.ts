/** Single-operator actual-device comparison. The independent reference is the
 * original exact scalar RGBA shader (no prefix). Small candidate radii use the
 * existing compensated f32 reducer and unchanged integrated weights; rejected
 * radii/channels retain exact output. This is not whole-app visual acceptance. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { initSync, rational_tent_kernel_rgba, certified_tent_kernel_rgba } from '../src/generated/design-kernel/design_kernel.js'
import { displayFilterWeights } from '../src/kernel/gpu/display-filter'
import { prefixRationalUnsupported } from '../src/kernel/gpu/prefix-preflight'
import { project, runProof, sha256 } from './exact-prefix-proof-utils'

if (process.env.VITE_DESIGN_BOUNDED_DISPLAY_FILTER !== '1') throw Error('Run with VITE_DESIGN_BOUNDED_DISPLAY_FILTER=1')
await runProof('futureox-bounded-display-filter', [], async proof => {
  const wasm = await readFile(join(project, 'public/kernel/design_kernel_bg.wasm')); initSync({ module: wasm })
  const radii = [.1, .3, 1, 3.25, 19.129743576049805, 31.999, 32, 32 + 2 ** -30, 64, 1 + 2 ** -30]
  const kernels = radii.map(radius => {
    const rational = rational_tent_kernel_rgba(radius), certified = certified_tent_kernel_rgba(radius)
    return { radius, rational: Array.from(rational), certified: Array.from(certified),
      weights: Array.from(displayFilterWeights(radius)), unsupported: prefixRationalUnsupported(rational) }
  })
  const fixtures = kernels.flatMap((kernel, index) => [0, 1].flatMap(axis => [false, true].map(clamp => ({
    name: `r${kernel.radius}-axis${axis}-${clamp ? 'clamp' : 'transparent-edge'}`, kernel: index, axis, clamp,
    channels: 15, pattern: 'normal', admitted: kernel.radius <= 32 && Math.ceil(Math.fround(kernel.radius)) === Math.ceil(kernel.radius),
  }))))
  for (const axis of [0, 1]) {
    fixtures.push({ name: `signed-hdr-axis${axis}`, kernel: 4, axis, clamp: false, channels: 15, pattern: 'signed-hdr', admitted: true })
    fixtures.push({ name: `alpha-only-axis${axis}`, kernel: 4, axis, clamp: true, channels: 8, pattern: 'normal', admitted: false })
    for (const kernel of [0, 4, 6]) for (const pattern of ['max-positive', 'max-negative', 'max-alternating', 'max-centre-cancellation'])
      fixtures.push({ name: `${pattern}-r${radii[kernel]}-axis${axis}`, kernel, axis, clamp: true, channels: 15, pattern, admitted: true })
    // At r=1 the exact coefficients are 1/6,2/3,1/6. A centre of
    // +/-M/2 with both neighbours -/+M has exactly zero RGB, although the
    // separately quantized display coefficients need not retain that identity.
    fixtures.push({ name: `exact-cancellation-r1-axis${axis}`, kernel: 2, axis, clamp: true, channels: 15, pattern: 'exact-cancellation', admitted: true })
    for (const pattern of ['max-positive', 'max-negative'])
      fixtures.push({ name: `${pattern}-rejected-r64-axis${axis}`, kernel: 8, axis, clamp: true, channels: 15, pattern, admitted: false })
  }
  const prepared = { cases: fixtures.length, wasmSha256: sha256(wasm), radii,
    gate: 'Every exact reference must be finite. For admitted fixtures, candidate must also be finite and maximum unrounded SDR encoded error < 1/255. Rejected fixtures require raw f32 equality. The r1 cancellation reference centre must be exactly zero.',
    reference: 'Production WebGpuDriver with scene.displayFilters=false and no prefix metadata: exact scalar channels.',
    scope: 'Numerical single-axis evidence only; final two-axis composition and authored scene screenshots remain separate gates.' }
  await proof.write('fixtures.json', { ...prepared, kernels, fixtures })
  if (proof.prepareOnly) return prepared
  const result = await proof.browser(page => page.evaluate(async ({ kernels, fixtures }) => {
    const { WebGpuDriver } = await import('/src/kernel/gpu/webgpu.ts')
    const { parameters } = await import('/src/kernel/gpu/types.ts')
    type Texture = import('/src/kernel/gpu/types.ts').Texture
    const driver = await WebGpuDriver.create(true, false, true, true, false), raw = driver as any
    const scene = (candidate: boolean) => ({ nodes: {}, displayFilters: candidate, displayFilterRadiusLimit: 32 }) as any
    const records: any[] = []; let components = 0, failed = 0, peakBytes = 0, activeCase: unknown
    const digest = async (values: Float32Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Float32Array(values).buffer)))
      .map(v => v.toString(16).padStart(2, '0')).join('')
    const encode = (v: number) => Math.min(1, Math.max(0, v <= .0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - .055))
    const floatClass = (v: number) => Number.isNaN(v) ? 'nan' : v === Infinity ? 'positive-infinity' : v === -Infinity ? 'negative-infinity' : 'finite'
    const finiteSummary = (values: Float32Array) => {
      let finiteComponents = 0, nanComponents = 0, positiveInfinityComponents = 0, negativeInfinityComponents = 0
      let finiteMinimum: number | null = null, finiteMaximum: number | null = null
      for (const value of values) {
        if (Number.isNaN(value)) nanComponents++
        else if (value === Infinity) positiveInfinityComponents++
        else if (value === -Infinity) negativeInfinityComponents++
        else { finiteComponents++; finiteMinimum = finiteMinimum === null ? value : Math.min(finiteMinimum, value); finiteMaximum = finiteMaximum === null ? value : Math.max(finiteMaximum, value) }
      }
      return { finiteComponents, nanComponents, positiveInfinityComponents, negativeInfinityComponents, finiteMinimum, finiteMaximum }
    }
    try {
      for (const f of fixtures) {
        const kernel = kernels[f.kernel], radius = kernel.radius, width = f.axis === 0 ? 193 : 7, height = f.axis === 1 ? 193 : 7
        const pixels = new Float32Array(width * height * 4), inputBits = new Uint32Array(pixels.buffer)
        const extreme = f.pattern.startsWith('max-') || f.pattern === 'exact-cancellation'
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const p = y * width + x, along = f.axis === 0 ? x : y, alpha = extreme ? 1 : [1, .5, .125, 0][(p * 7 + x) % 4]
          for (let c = 0; c < 3; c++) pixels[p * 4 + c] = ((p * 37 + c * 17) % 251) / 251 * alpha *
            (f.pattern === 'signed-hdr' ? ((p + c) % 3 ? 4 : -2) : 1)
          if (extreme) for (let c = 0; c < 3; c++) {
            let word = 0x7f7fffff
            if (f.pattern === 'max-negative') word = 0xff7fffff
            else if (f.pattern === 'max-alternating') word = (along + c) % 2 ? 0xff7ffffe : 0x7f7fffff
            else if (f.pattern === 'max-centre-cancellation' || f.pattern === 'exact-cancellation') {
              const negative = (along === 96) === (c === 1)
              word = (along === 96 ? 0x7effffff : 0x7f7fffff) | (negative ? 0x80000000 : 0)
            }
            inputBits[p * 4 + c] = word >>> 0
          }
          pixels[p * 4 + 3] = alpha
        }
        const inputSummary = finiteSummary(pixels)
        if (inputSummary.finiteComponents !== pixels.length) throw Error('Extreme fixture input was not entirely finite')
        let reference: Float32Array | undefined, referenceValid = true
        const variants: any[] = []
        activeCase = { ...f, radius, inputSummary, sourceSha256: await digest(pixels), variants }
        for (const candidate of [false, true]) {
          await driver.prepareScene(scene(candidate)); await driver.prepareFilters(candidate)
          driver.begin(new Float32Array(0)); const owned: Texture[] = [], own = (t: Texture) => { owned.push(t); return t }
          try {
            const source = own(driver.uploadLinear(pixels, width, height)), target = own(driver.create(width, height))
            const admitted = candidate && driver.usesDisplayFilter(radius, f.channels)
            if (admitted !== (candidate && f.admitted)) throw Error(`${f.name}: unexpected bounded selection`)
            let coefficients: Texture, certificate: Texture | undefined
            if (admitted) {
              const weights = new Float32Array(256 * 4)
              kernel.weights.forEach((v, i) => { weights[i * 4] = v })
              coefficients = own(driver.uploadParameters(weights, 256, 1))
            } else {
              coefficients = own(driver.uploadRgba8(new Uint8Array(kernel.rational), kernel.rational.length / 4, 1))
              coefficients.prefixRationalUnsupported = kernel.unsupported
              certificate = own(driver.uploadRgba8(new Uint8Array(kernel.certified), kernel.certified.length / 4, 1))
            }
            const r = { x: -13, y: 27, w: width, h: height }
            const u = parameters(r, r, { x: 0, y: 0, w: coefficients.width, h: 1 }, { x: 0, y: 0, w: certificate?.width || 0, h: 1 })
            u[16] = 22; u.set([radius, f.axis, Number(f.clamp), 1], 36)
            const inputs = [source, coefficients, ...(certificate ? [certificate] : [])], filter = { kind: 'tent' as const, radius }
            if (candidate) driver.prepareFilterPass(target, u, inputs, f.channels, filter, 256 * 1024 * 1024 - driver.stats().textureBytes - driver.scratchBytes)
            driver.pass(target, u, inputs, undefined, f.channels, candidate ? filter : undefined)
            if (driver.boundedDisplayFilterPasses !== (admitted ? 1 : 0) || driver.pairedFilterPasses !== 0)
              throw Error(`${f.name}: actual pipeline does not match admission`)
            if (admitted && (target.finitePixels || target.opaqueAlpha)) throw Error('Approximate filter acquired exact output certificate')
            const actual = await driver.readSurface(target), rawBits = new Uint32Array(actual.buffer)
            const outputSummary = finiteSummary(actual)
            let rawDifferences = 0, maxAbsolute = 0, maxAlpha = 0, maxEncodedByteError = 0, maxQuantizedByteDifference = 0, nonfinite = 0
            const examples: any[] = [], nonfiniteExamples: any[] = []
            const centre = ((f.axis === 0 ? 3 : 96) * width + (f.axis === 0 ? 96 : 3)) * 4
            const centreBits = Array.from(rawBits.subarray(centre, centre + 4))
            const centreClasses = Array.from(actual.subarray(centre, centre + 4), floatClass)
            if (candidate) {
              if (!reference) throw Error('Missing exact scalar reference')
              const referenceBits = new Uint32Array(reference.buffer)
              for (let i = 0; i < actual.length; i++) {
                const bothFinite = Number.isFinite(actual[i]) && Number.isFinite(reference[i])
                if (!bothFinite) {
                  nonfinite++
                  if (nonfiniteExamples.length < 8) nonfiniteExamples.push({ component: i, referenceClass: floatClass(reference[i]), candidateClass: floatClass(actual[i]), referenceBits: referenceBits[i], candidateBits: rawBits[i] })
                } else {
                  const error = Math.abs(actual[i] - reference[i]); maxAbsolute = Math.max(maxAbsolute, error)
                  if (i % 4 === 3) maxAlpha = Math.max(maxAlpha, error)
                  const a = i % 4 === 3 ? Math.min(1, Math.max(0, reference[i])) : encode(reference[i])
                  const b = i % 4 === 3 ? Math.min(1, Math.max(0, actual[i])) : encode(actual[i])
                  maxEncodedByteError = Math.max(maxEncodedByteError, Math.abs(a - b) * 255)
                  maxQuantizedByteDifference = Math.max(maxQuantizedByteDifference, Math.abs(Math.round(a * 255) - Math.round(b * 255)))
                }
                if (rawBits[i] !== referenceBits[i]) { rawDifferences++; if (examples.length < 8) examples.push({ component: i,
                  reference: Number.isFinite(reference[i]) ? reference[i] : null, candidate: Number.isFinite(actual[i]) ? actual[i] : null,
                  referenceClass: floatClass(reference[i]), candidateClass: floatClass(actual[i]), referenceBits: referenceBits[i], candidateBits: rawBits[i] }) }
              }
              components += actual.length
              if (!referenceValid || nonfinite > 0 || (f.admitted ? maxEncodedByteError >= 1 : rawDifferences > 0)) failed++
            } else {
              reference = actual.slice()
              referenceValid = outputSummary.finiteComponents === actual.length &&
                (f.pattern !== 'exact-cancellation' || centreBits.slice(0, 3).every(bits => (bits & 0x7fffffff) === 0))
            }
            let counters: unknown
            if (raw.prefix?.scratchBytes) {
              raw.prefix.encodeCountersReadback(raw.encoder); await driver.checkpoint('checkpoint'); counters = await raw.prefix.readCounters()
            }
            peakBytes = Math.max(peakBytes, driver.stats().textureBytes + driver.scratchBytes)
            const record = { candidate, admitted, boundedPasses: driver.boundedDisplayFilterPasses, pairedPasses: driver.pairedFilterPasses,
              drawCalls: driver.drawCalls, prefixCounters: counters, components: actual.length, rawDifferences, maxAbsolute, maxAlpha,
              maxEncodedByteError, maxQuantizedByteDifference, nonfinite, ...outputSummary, referenceValid,
              centreBits, centreClasses, nonfiniteExamples, examples, sha256: await digest(actual) }
            variants.push(record)
            await driver.finish(target, r, width, height, false, undefined, false)
            if (driver.scratchBytes !== 0) throw Error('Filter scratch survived finish')
          } catch (error) { await driver.abortFrameAndReleaseFilterScratch('cancel').catch(() => {}); throw error }
          finally { for (const t of owned) driver.destroy(t) }
        }
        records.push(activeCase)
      }
      return { status: failed ? 'failed' : 'passed', cases: records.length, components, failed, peakBytes, adapter: driver.stats().adapter, records }
    } catch (error) { return { status: 'failed', error: String(error), components, failed, peakBytes, records, activeCase } }
    finally { driver.dispose() }
  }, { kernels, fixtures }))
  await proof.write('gpu-result.json', result)
  if (result.status !== 'passed') throw Error('Bounded display filter failed; see unrounded metrics in gpu-result.json')
  return { ...prepared, ...result }
})
