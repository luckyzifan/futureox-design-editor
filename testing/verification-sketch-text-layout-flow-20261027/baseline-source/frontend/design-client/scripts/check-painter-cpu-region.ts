/** Independent CPU screen-window comparison for an actual unmanaged GPU
 * readback. Private documents, request payloads and pixels are never curated.
 * Restrict to the unshifted top-left window: changing the camera origin would
 * introduce a different rounding/phase question into this filter comparison. */
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { initSync, VectorEngine } from '../src/generated/design-kernel/design_kernel.js'
import { project, runProof, sha256 } from './exact-prefix-proof-utils'

const documentPath = process.env.DESIGN_PAINTER_DOCUMENT
const requestsPath = process.env.DESIGN_PAINTER_REQUESTS
const evidence = process.env.DESIGN_PAINTER_GPU_EVIDENCE
if (!documentPath || !requestsPath || !evidence) throw Error('Supply document, requests and actual GPU evidence')
const files = ['fixtures.json', 'gpu-result.json', 'inputs-before.json', 'inputs-after.json', 'private-readback-pixels-0.json']
  .map(name => resolve(evidence, name))
await runProof('futureox-painter-cpu-region', [resolve(documentPath), resolve(requestsPath), ...files], async proof => {
  const [documentBytes, requestsBytes, wasm, font, ...bound] = await Promise.all([
    readFile(documentPath), readFile(requestsPath), readFile(join(project, 'public/kernel/design_kernel_bg.wasm')),
    readFile(join(project, 'public/fonts/NotoSansSC.ttf')), ...files.map(file => readFile(file)),
  ])
  const [fixture, gpu, before, after, pixels] = bound.map(bytes => JSON.parse(bytes.toString()))
  if (JSON.stringify(before) !== JSON.stringify(after)) throw Error('GPU inputs changed during execution')
  for (const [key, bytes] of [['documentSha256', documentBytes], ['requestsSha256', requestsBytes],
    ['wasmSha256', wasm], ['fontSha256', font]] as const)
    if (fixture[key] !== sha256(bytes)) throw Error(`GPU/CPU ${key} mismatch`)
  const document = JSON.parse(documentBytes.toString()), requests = JSON.parse(requestsBytes.toString())
  const request = requests[0], viewport = request?.gpuViewport
  if (requests.length !== 1 || !viewport || viewport.x !== 0 || viewport.y !== 0 ||
      ![viewport.w, viewport.h].every(value => Number.isInteger(value) && value > 0) ||
      viewport.w * viewport.h > 1048576 || document.colorManagement)
    throw Error('Only one unmanaged, unshifted top-left screen window is supported')
  const record = gpu.records?.[0]
  if (!gpu.allCompleted || !record?.completed || record.pixelFormat !== 'readback-rgba8' ||
      pixels.format !== 'rgba8unorm' || pixels.index !== 0 || !Array.isArray(pixels.rgba) ||
      pixels.rgba.length !== viewport.w * viewport.h * 4 ||
      !pixels.rgba.every(value => Number.isInteger(value) && value >= 0 && value <= 255))
    throw Error('Bound actual RGBA8 GPU readback missing')
  const actual = new Uint8Array(pixels.rgba)
  if (sha256(actual) !== record.outputSha256) throw Error('Private GPU pixels do not match the bound output')
  const { gpuViewport: _viewport, gpuPainterSupport: _support, gpuPainterCaptureReads: _reads, ...original } = request
  const cpuRequest = { ...original, width: viewport.w, height: viewport.h }
  const manifest = { documentSha256: fixture.documentSha256, requestsSha256: fixture.requestsSha256,
    wasmSha256: fixture.wasmSha256, fontSha256: fixture.fontSha256,
    gpuResultSha256: sha256(bound[1]), gpuOutputSha256: sha256(actual),
    cpuRequestSha256: sha256(JSON.stringify(cpuRequest)), width: viewport.w, height: viewport.h,
    scope: 'Independent unchanged CPU render_rgba of the unshifted screen window versus actual unmanaged GPU RGBA8 readback. Not latency, full document, motion, export or old large-radius GPU equivalence.' }
  await proof.write('fixtures.json', manifest)
  if (proof.prepareOnly) return { ...manifest, cpuExecuted: false }
  initSync({ module: wasm })
  const engine = new VectorEngine(), started = performance.now()
  let expected: Uint8Array
  try {
    engine.load_font(font); engine.load_document(documentBytes.toString())
    expected = engine.render_rgba(JSON.stringify(cpuRequest))
  } finally { engine.free() }
  if (expected.length !== actual.length) throw Error('CPU/GPU screen-window size mismatch')
  let differentBytes = 0, maximumByteDifference = 0
  for (let i = 0; i < actual.length; i++) {
    const difference = Math.abs(expected[i] - actual[i])
    if (difference) differentBytes++
    maximumByteDifference = Math.max(maximumByteDifference, difference)
  }
  await proof.write('private-cpu-pixels.json', { rgba: [...expected] })
  const result = { ...manifest, cpuExecuted: true, cpuElapsedMs: performance.now() - started,
    components: actual.length, differentBytes, maximumByteDifference, cpuOutputSha256: sha256(expected) }
  await proof.write('cpu-result.json', result)
  if (differentBytes) throw Error(`CPU/GPU differ in ${differentBytes} bytes (maximum ${maximumByteDifference})`)
  return result
})
