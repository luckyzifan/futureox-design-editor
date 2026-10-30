/** CPU-only cost decomposition using actual WASM scene JSON. This never starts
 * a browser/GPU and does not measure native input-to-display latency. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.log('node scripts/check-exact-cache-hit-cost.mjs [--output=/new/directory] [--repo=/path/to/core] [--fixture=/path/to/file.fd] [--rounds=4]')
  console.log('Pure CPU Node/V8 microbenchmark. No browser, GPU, native latency, or rendered-pixel acceptance. Output must not already exist.')
  process.exit(0)
}
const values = new Map()
for (const arg of args) {
  const match = /^--(output|repo|fixture|rounds)=(.+)$/.exec(arg)
  if (!match || values.has(match[1])) throw new Error(`Unknown or repeated argument: ${arg}`)
  values.set(match[1], match[2])
}
const script = fileURLToPath(import.meta.url)
const repository = resolve(values.get('repo') || join(dirname(script), '../../..'))
const project = join(repository, 'frontend/design-client')
const rounds = Number(values.get('rounds') || 4)
if (!Number.isInteger(rounds) || rounds < 2 || rounds > 12 || rounds % 2)
  throw new Error('--rounds must be an even integer from 2 through 12')
const fixturePath = resolve(values.get('fixture') || join(repository, 'testing/review/design-desktop-macos-gui-2026-10-10/hdr-performance/combined-fixture.forma'))
const requestedOutput = values.get('output')
if (requestedOutput && !isAbsolute(requestedOutput)) throw new Error('--output must be absolute')
// Exclusive creation intentionally rejects even an existing empty directory.
const output = requestedOutput
  ? (await mkdir(requestedOutput, { mode: 0o700 }), requestedOutput)
  : await mkdtemp(join(tmpdir(), 'forma-cache-hit-cost-'))
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const paths = {
  wasm: join(project, 'public/kernel/design_kernel_bg.wasm'),
  binding: join(project, 'src/generated/design-kernel/design_kernel.js'),
  font: join(project, 'public/fonts/NotoSansSC.ttf'),
  tilePlanner: join(project, 'src/kernel/tile-cache.ts'),
  exactCache: join(project, 'src/kernel/exact-tile-cache.ts'),
  worker: join(project, 'src/kernel/render-worker.ts'),
  fixture: fixturePath,
  runner: script,
}
let kernel
const startedAt = new Date().toISOString()
console.log(JSON.stringify({ output, rounds, scope: 'CPU only; no GPU/native frame-rate claim' }))
try {
  const bytes = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, await readFile(path)])))
  const hashes = Object.fromEntries(Object.entries(bytes).map(([key, data]) => [key, digest(data)]))
  let gitHead = null
  try { gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8', timeout: 5000 }).trim() } catch { /* File digests remain authoritative outside a Git checkout. */ }
  await writeFile(join(output, 'inputs.json'), JSON.stringify({
    startedAt, rounds, gitHead,
    files: Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, { path: relative(repository, path), sha256: hashes[key] }])),
    runtime: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch },
    typeLoading: 'Node transforms the unchanged standalone TypeScript helpers in memory; no application source or worker is rewritten.',
  }, null, 2))

  // These two production helpers are standalone modules. Execute their actual
  // TypeScript after type transformation, without requiring a repo build.
  const loadHelper = async (key) => {
    const code = stripTypeScriptTypes(bytes[key].toString('utf8'), { mode: 'transform', sourceUrl: pathToFileURL(paths[key]).href })
    return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
  }
  const { planTiles, devicePixelPhase } = await loadHelper('tilePlanner')
  const { compilationWitness, sameBytes } = await loadHelper('exactCache')
  const { initSync, VectorEngine } = await import(pathToFileURL(paths.binding).href)
  initSync({ module: bytes.wasm })
  kernel = new VectorEngine()
  kernel.load_font(bytes.font)
  const document = JSON.parse(bytes.fixture.toString('utf8'))
  kernel.load_document(JSON.stringify(document))

  const cameras = [
    { zoom: 2, view: { x: -213.33333333333326, y: -194, zoom: 2 } },
    { zoom: 4, view: { x: -1306.6666666666665, y: -1250, zoom: 4 } },
  ]
  const frames = []
  for (const { zoom, view } of cameras) {
    const width = 1760, height = 1724
    const tiles = planTiles({ x: -view.x / zoom, y: -view.y / zoom, width: width / zoom, height: height / zoom }, zoom, 256,
      { x: devicePixelPhase(view.x, 1), y: devicePixelPhase(view.y, 1) })
    const rows = [], start = performance.now()
    for (const tile of tiles) {
      const options = { pageId: document.pages[0].id, width: tile.width, height: tile.height, view,
        transparent: false, grid: true, rasterProfile: 'figma',
        gpuViewport: { x: tile.x + Math.floor(view.x), y: tile.y + Math.floor(view.y), w: tile.width, h: tile.height } }
      rows.push({ options, raw: kernel.compile_gpu(JSON.stringify(options)) })
    }
    const compileCaptureMs = performance.now() - start
    for (const row of rows) {
      row.witness = compilationWitness(row.raw)
      row.equalWitness = compilationWitness(row.raw)
      assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(row.witness), row.raw)
      assert.equal(sameBytes(row.witness, row.equalWitness), true)
    }
    frames.push({ zoom, view, width, height, compileCaptureMs, rows })
  }
  kernel.free(); kernel = undefined

  let sink = 0
  const profile = []
  for (const frame of frames) {
    const phases = {
      parse() {
        for (const row of frame.rows) {
          const scene = JSON.parse(row.raw)
          sink += scene.vertices.length + (scene.curves?.length || 0) + scene.roots.length
        }
      },
      utf8() {
        for (const row of frame.rows) sink += compilationWitness(row.raw).byteLength
      },
      compare() {
        for (const row of frame.rows) { assert.equal(sameBytes(row.witness, row.equalWitness), true); sink++ }
      },
      eagerHit() {
        for (const row of frame.rows) {
          const scene = JSON.parse(row.raw), witness = compilationWitness(row.raw)
          assert.equal(sameBytes(row.witness, witness), true)
          sink += scene.vertices.length
        }
      },
      deferredHit() {
        for (const row of frame.rows) { assert.equal(sameBytes(row.witness, compilationWitness(row.raw)), true); sink++ }
      },
    }
    // Warm every operation, then alternate measurement order. Compilation,
    // digesting, parsing result files and writing evidence are not timed here.
    for (const operation of Object.values(phases)) operation()
    const samples = []
    for (let round = 0; round < rounds; round++) {
      const order = Object.keys(phases)
      if (round % 2) order.reverse()
      const sample = { round, order }
      for (const name of order) {
        const start = performance.now(); phases[name](); sample[name] = performance.now() - start
      }
      samples.push(sample)
    }
    const median = (numbers) => {
      const sorted = [...numbers].sort((a, b) => a - b), middle = sorted.length / 2
      return (sorted[middle - 1] + sorted[middle]) / 2
    }
    const medians = Object.fromEntries(Object.keys(phases).map(name => [name, median(samples.map(sample => sample[name]))]))
    profile.push({ zoom: frame.zoom, view: frame.view, width: frame.width, height: frame.height, tiles: frame.rows.length,
      compileCaptureMs: frame.compileCaptureMs, rawUtf8Bytes: frame.rows.reduce((sum, row) => sum + row.witness.byteLength, 0),
      rawScenes: frame.rows.map(row => ({ options: row.options, sha256: digest(row.witness), utf8Bytes: row.witness.byteLength })),
      medians, samples, isolatedMedianSavingMs: medians.eagerHit - medians.deferredHit,
      parseShareOfMeasuredPostCompile: medians.parse / (medians.parse + medians.utf8 + medians.compare) })
  }
  const changedInputs = []
  for (const [key, path] of Object.entries(paths)) if (digest(await readFile(path)) !== hashes[key]) changedInputs.push(key)
  const result = {
    status: changedInputs.length ? 'failed' : 'passed', startedAt, finishedAt: new Date().toISOString(), rounds,
    scope: 'Pure CPU Node/V8 cost decomposition on actual WASM scene JSON. Eager/deferred labels describe isolated all-hit microbench paths, not separate worker/GPU executions or production/native latency.',
    excluded: ['GPU rendering', 'pixel correctness acceptance', 'LRU bookkeeping', 'MessageChannel yielding', 'pixel copying/transport', 'native input-to-display time'],
    compileCaptureScope: 'One real capture per camera, including options serialization; reported separately from repeated post-compile operation timings.',
    runtime: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch },
    hashes, changedInputs, profile, sink,
  }
  await writeFile(join(output, 'results.json'), JSON.stringify(result, null, 2))
  assert.deepEqual(changedInputs, [], 'Inputs changed during CPU profiling')
  console.log(JSON.stringify({ output, status: result.status, profile: profile.map(({ rawScenes, samples, ...summary }) => summary) }, null, 2))
} catch (error) {
  await writeFile(join(output, 'failure.json'), JSON.stringify({ status: 'failed', error: String(error), startedAt, finishedAt: new Date().toISOString() }, null, 2))
  throw error
} finally {
  kernel?.free()
}
