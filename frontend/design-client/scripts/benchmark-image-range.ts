/** CPU only: matched production finite/range certificates over real 117 bytes.
 * No GPU, browser, app launch, decoding or hashing is included in timed batches. */
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { stripTypeScriptTypes } from 'node:module'
import { performance } from 'node:perf_hooks'
import assert from 'node:assert/strict'
import { initSync, VectorEngine } from '../src/generated/design-kernel/design_kernel.js'
import { certifyExactImageRange } from '../src/kernel/gpu/exact-image-x-table.ts'

const scenePath = process.env.DESIGN_117_SCENE, documentPath = process.env.DESIGN_117_DOCUMENT
if (!scenePath || !documentPath) throw Error('Set DESIGN_117_SCENE and DESIGN_117_DOCUMENT to the actual imported fixture')
const rounds = Number(process.env.DESIGN_RANGE_ROUNDS || 5), iterations = Number(process.env.DESIGN_RANGE_ITERATIONS || 20)
if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 10 || !Number.isSafeInteger(iterations) || iterations < 1 || iterations > 100)
  throw Error('Rounds must be 1..10 and iterations 1..100')
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const baselinePath = new URL('../../../testing/verification-render-deep-20261020/image-range-scan/baseline-range.ts.txt', import.meta.url)
const candidatePath = new URL('../src/kernel/gpu/exact-image-x-table.ts', import.meta.url)
const [baselineSource, candidateSource, wasm, sceneBytes, documentBytes] = await Promise.all([
  readFile(baselinePath, 'utf8'), readFile(candidatePath, 'utf8'),
  readFile(new URL('../public/kernel/design_kernel_bg.wasm', import.meta.url)), readFile(scenePath), readFile(documentPath),
])
const baseline = (await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(baselineSource, { mode: 'strip' })).toString('base64')))
  .certifyExactImageRange as typeof certifyExactImageRange
const scene = JSON.parse(sceneBytes.toString()), document = JSON.parse(documentBytes.toString())
const nodeId = '1AB99304-455A-4A9E-9473-8923A1330FA4', node = scene.nodes[nodeId]
if (!node || node.fills[0]?.kind !== 'image' || node.fills[0].image !== document.nodes[nodeId]?.fills[0]?.image)
  throw Error('Actual 117 source identity changed')
initSync({ module: wasm })
const engine = new VectorEngine()
let pixels: Float32Array, dimensions: number[]
try {
  engine.load_document(documentBytes.toString())
  dimensions = JSON.parse(engine.image_info(node.fills[0].image))
  pixels = engine.image_linear(node.fills[0].image)
} finally { engine.free() }
const raw = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), pixelsHash = hash(raw)
const expected = baseline(pixels)
assert(expected, 'Actual source must be finite')
assert.deepEqual(certifyExactImageRange(pixels), expected)
const funcs = { A: baseline, B: certifyExactImageRange }, samples: { round: number; position: number; variant: 'A' | 'B'; batchMs: number; perCallMs: number }[] = []
for (let warmup = 0; warmup < 12; warmup++) for (const fn of Object.values(funcs)) assert.deepEqual(fn(pixels), expected)
for (let round = 0; round < rounds; round++) for (const [position, variant] of (['A', 'B', 'B', 'A'] as const).entries()) {
  let result: ReturnType<typeof certifyExactImageRange>
  const started = performance.now()
  for (let index = 0; index < iterations; index++) result = funcs[variant](pixels)
  const batchMs = performance.now() - started
  assert.deepEqual(result!, expected)
  samples.push({ round, position, variant, batchMs, perCallMs: batchMs / iterations })
}
assert.equal(hash(raw), pixelsHash, 'Certificate scans must not mutate the source')
assert.equal(hash(await readFile(candidatePath)), hash(candidateSource), 'Production source changed during benchmark')
assert.equal(hash(await readFile(baselinePath)), hash(baselineSource), 'Baseline source changed during benchmark')
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2 }
const summary = (variant: 'A' | 'B') => {
  const values = samples.filter(sample => sample.variant === variant).map(sample => sample.perCallMs)
  return { variant, batches: values.length, medianMs: median(values), minMs: Math.min(...values), maxMs: Math.max(...values) }
}
const A = summary('A'), B = summary('B')
const result = { status: 'passed', runtime: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch },
  fixture: { nodeId, dimensions, components: pixels.length, pixelsSha256: pixelsHash, uriSha256: hash(node.fills[0].image),
    sceneSha256: hash(sceneBytes), documentSha256: hash(documentBytes), wasmSha256: hash(wasm) },
  source: { baselineSha256: hash(baselineSource), candidateSha256: hash(candidateSource) },
  rounds, iterations, warmupsPerVariant: 12, order: 'ABBA', expected, samples, summary: { A, B, ratio: B.medianMs / A.medianMs },
  limitations: 'One actual 117 image, repeated CPU-only Node/V8 calls. JIT warmup, certificate allocation and WeakSet insertion are retained; decode/hash/compare and GPU/application work are excluded. No whole-editor latency claim.' }
if (process.env.DESIGN_RANGE_OUTPUT) await writeFile(process.env.DESIGN_RANGE_OUTPUT, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ status: result.status, fixture: result.fixture, summary: result.summary }))
