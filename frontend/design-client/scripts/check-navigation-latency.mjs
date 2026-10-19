/** Replays production zoom admission and renders its exact final cameras with
 * the actual WASM CPU kernel. No browser, GPU, Electron or display latency is
 * measured. Admission clocks are deterministic; raster timings are wall time. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repository = resolve(project, '../..')
const baselineCommit = '71d32153e6f55b3723c99708b4c4c49ac7342e67'
const relativeSource = 'frontend/design-client/src/kernel/navigation-zoom.ts'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const option = process.argv.slice(2)
if (option.some(arg => !arg.startsWith('--output=')) || option.length > 1)
  throw Error('Usage: node scripts/check-navigation-latency.mjs [--output=/new/directory]')
const output = option[0] ? resolve(option[0].slice('--output='.length)) : await mkdtemp(join(tmpdir(), 'design-navigation-'))
if (option[0]) await mkdir(output, { mode: 0o700 })
const baselineSource = execFileSync('git', ['show', `${baselineCommit}:${relativeSource}`], { cwd: repository, encoding: 'utf8' })
const source = await readFile(join(repository, relativeSource), 'utf8')
const load = code => import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(code, { mode: 'transform' })).toString('base64')}`)
const [{ NavigationZoom: Before }, { NavigationZoom: After }] = await Promise.all([load(baselineSource), load(source)])
const experimental = Owner => class extends Owner { constructor(view) { super(view, { adaptiveQuiet: true }) } }
const Experimental = experimental(After)
const camera = (zoom, x = 0, y = 0) => ({ x, y, zoom })
function replay(Owner, hz, inputs, finalView, capture = false, maxExact = 1) {
  const owner = new Owner(camera(.05)), samples = []
  let index = 0, sequence = 0
  const record = (at, value) => {
    if (value.sequence !== sequence) samples.push({ at, ...value })
    sequence = value.sequence
  }
  const end = inputs.at(-1).at
  for (let frame = 0; frame * 1000 / hz <= end + 500; frame++) {
    const at = frame * 1000 / hz
    while (index < inputs.length && inputs[index].at <= at + 1e-8) {
      const input = inputs[index++]
      record(input.at, owner.update(input.view, input.at))
    }
    record(at, owner.frame(at))
  }
  const finals = samples.filter(sample => !sample.active), previews = samples.filter(sample => sample.active)
  assert.ok(finals.length >= 1 && finals.length <= maxExact, 'completed exact work must remain bounded across short resumes')
  assert.deepEqual(finals.at(-1).view, finalView, 'last exact camera must be retained without quantization')
  assert.ok(finals.at(-1).at >= end, 'final exact work must use the final input')
  for (let i = 1; i < previews.length; i++)
    if (previews[i].sequence === previews[i - 1].sequence + 1)
      assert.ok(previews[i].at - previews[i - 1].at >= 160 - 1e-7, 'preview cadence cannot increase inside an active gesture')
  return { delayMs: finals.at(-1).at - end, previews: previews.length, exactAdmissions: finals.length, exact: finals.at(-1).view, ...(capture ? { samples } : {}) }
}
const traces = []
for (let seed = 0; seed < 4096; seed++) {
  const hz = [60, 90, 120, 144][seed % 4]
  const mode = ['dense', 'sparse-80ms', 'jittered', 'isolated'][Math.floor(seed / 4) % 4]
  const finalView = camera([.1, 1, 4, 32][Math.floor(seed / 16) % 4], -127.25 + seed % 9, 63.125 - seed % 7)
  const count = mode === 'isolated' ? 1 : 16 + seed % 67
  const inputs = []
  let at = 0
  for (let index = 0; index < count; index++) {
    const fraction = (index + 1) / count
    at += mode === 'sparse-80ms' ? 80 : mode === 'jittered' ? (index % 7 === 0 ? 2 : 1) * 1000 / hz : 1000 / hz
    inputs.push({ at, view: index + 1 === count ? finalView : camera(.1 * 320 ** fraction, finalView.x * fraction, finalView.y * fraction) })
  }
  const before = replay(Before, hz, inputs, finalView), after = replay(After, hz, inputs, finalView)
  assert.ok(after.delayMs <= before.delayMs + 1e-7)
  assert.ok(after.previews <= before.previews)
  if (mode === 'sparse-80ms' || mode === 'isolated') assert.ok(after.delayMs >= 160 - 1e-7)
  const adaptive = replay(Experimental, hz, inputs, finalView)
  traces.push({ seed, hz, mode, events: count, before, after, experimental: adaptive })
}
const summarize = rows => {
  const percentile = values => values.sort((a, b) => a - b)[Math.floor(values.length * .95)]
  return { traces: rows.length,
    beforeP95Ms: percentile(rows.map(row => row.before.delayMs)),
    afterP95Ms: percentile(rows.map(row => row.after.delayMs)),
    meanSavedMs: rows.reduce((sum, row) => sum + row.before.delayMs - row.after.delayMs, 0) / rows.length,
    previewsBefore: rows.reduce((sum, row) => sum + row.before.previews, 0),
    previewsAfter: rows.reduce((sum, row) => sum + row.after.previews, 0) }
}
const admission = Object.fromEntries(['dense', 'sparse-80ms', 'jittered', 'isolated'].map(mode => [mode, summarize(traces.filter(row => row.mode === mode))]))
const experimentalAdmission = Object.fromEntries(['dense', 'sparse-80ms', 'jittered', 'isolated'].map(mode =>
  [mode, summarize(traces.filter(row => row.mode === mode).map(row => ({ before: row.before, after: row.experimental })))]))
console.log(JSON.stringify({ stage: 'admission', traces: traces.length, defaultAdmission: admission, experimentalAdmission }))

// Disable the short-resume fallback and restore the rejected four-interval
// threshold as an explicit negative control.
// This reproduces the rejected adaptive policy rather than hiding repeated
// work behind a held renderer or coalescing away already completed frames.
const guard = 'this.resumedBeforeQuiet || '
assert.equal(source.split(guard).length, 2, 'negative control must disable exactly one production guard')
const minimum = 'const CADENCE_REQUIRED_INTERVALS = CADENCE_INTERVALS'
assert.equal(source.split(minimum).length, 2, 'negative control must restore exactly one rejected threshold')
const { NavigationZoom: UnsafeNavigation } = await load(source.replace(guard, '').replace(minimum, 'const CADENCE_REQUIRED_INTERVALS = 4'))
const UnsafeAdaptive = experimental(UnsafeNavigation)
const shortResumes = []
for (const [bursts, changes, period] of [[13, 5, 96], [101, 5, 96], [20, 20, 224]]) {
  for (const hz of [60, 90, 120, 144]) {
    const count = bursts * changes
    const inputs = Array.from({ length: bursts }, (_, burst) =>
      Array.from({ length: changes }, (_, index) => ({ at: burst * period + index * 8,
        view: camera(.1 * 320 ** ((burst * changes + index + 1) / count), 5.25, 7.125) }))).flat()
    const finalView = inputs.at(-1).view
    const before = replay(Before, hz, inputs, finalView, true)
    const after = replay(After, hz, inputs, finalView, true)
    const adaptive = replay(Experimental, hz, inputs, finalView, true, 2)
    const unsafe = replay(UnsafeAdaptive, hz, inputs, finalView, true, Infinity)
    assert.deepEqual(after.samples.map(({ active, view }) => ({ active, view })),
      before.samples.map(({ active, view }) => ({ active, view })), 'default must not amplify or change the accepted work sequence')
    assert.equal(after.exactAdmissions, before.exactAdmissions)
    assert.ok(after.previews <= before.previews)
    assert.ok(adaptive.exactAdmissions <= before.exactAdmissions + (changes === 5 ? 0 : 1))
    assert.ok(adaptive.previews <= before.previews + 1)
    assert.ok(after.delayMs >= 160 - 1e-7)
    assert.ok(unsafe.exactAdmissions > after.exactAdmissions, 'negative control must expose repeated completed exact work')
    shortResumes.push({ hz, bursts, changes, period, before, after, experimental: adaptive, unsafe })
  }
}
console.log(JSON.stringify({ stage: 'short-resume completed-work guard', rows: shortResumes.map(({ hz, bursts, changes, period, before, after, unsafe }) =>
  ({ hz, bursts, changes, period, before: [before.previews, before.exactAdmissions], after: [after.previews, after.exactAdmissions], unsafe: [unsafe.previews, unsafe.exactAdmissions] })) }))

const wasm = await readFile(join(project, 'public/kernel/design_kernel_bg.wasm'))
const font = await readFile(join(project, 'public/fonts/NotoSansSC.ttf'))
const { initSync, VectorEngine } = await import(pathToFileURL(join(project, 'src/generated/design-kernel/design_kernel.js')).href)
initSync({ module: wasm })
const kernel = new VectorEngine()
const document = { schemaVersion: 2, rasterProfile: 'analytic', id: 'navigation-3200', name: 'Deterministic 3200-node navigation',
  pages: [{ id: 'page', name: 'page', children: [], background: '#f5f5f5' }], nodes: {} }
for (let index = 0; index < 3200; index++) {
  const id = `n${index}`, color = ['#235fa0', '#dd7733', '#338866', '#9644bb'][index % 4]
  const gradient = index % 7 === 0
  document.nodes[id] = { id, kind: index % 3 === 0 ? 'ellipse' : 'rectangle', name: id,
    transform: [1, 0, 0, 1, (index % 64) * 8 + .125, Math.floor(index / 64) * 8 + .25], width: 6.5, height: 5.75,
    children: [], visible: true, locked: false, opacity: .85 + (index % 4) * .05, blend: 'normal',
    fills: [{ id: `p${index}`, kind: gradient ? 'linear' : 'solid', visible: true, color, opacity: 1, blend: 'normal',
      angle: 35, stops: [{ offset: 0, color }, { offset: 1, color: '#f5b8dc' }], fit: 'cover' }],
    strokes: [], effects: [], radii: [1, 1, 1, 1], smoothing: 0, clip: false, mask: false }
  document.pages[0].children.push(id)
}
const fixture = JSON.stringify(document)
await writeFile(join(output, 'fixture-3200.json'), fixture)
const cpu = [], rasterWork = [], shortResumeRasterWork = []
try {
  kernel.load_font(font)
  kernel.load_document(fixture)
  for (const zoom of [.1, 1, 4, 32]) {
    const view = camera(zoom, 5.25, 7.125)
    const input = Array.from({ length: 120 }, (_, i) => ({ at: (i + 1) * 1000 / 120,
      view: i === 119 ? view : camera(.1 * 320 ** ((i + 1) / 120), i / 16, -i / 32) }))
    const before = replay(Before, 120, input, view), after = replay(After, 120, input, view)
    const opts = value => JSON.stringify({ pageId: 'page', width: 256, height: 192, view: value,
      transparent: false, grid: false, rasterProfile: 'analytic' })
    const beforeOptions = opts(before.exact), afterOptions = opts(after.exact)
    assert.equal(beforeOptions, afterOptions)
    const reference = kernel.render_rgba(beforeOptions)
    assert.equal(reference.length, 256 * 192 * 4)
    assert.ok(reference.some((byte, i) => i % 4 !== 3 && byte !== 245), 'fixture cannot certify empty pixels')
    const times = []
    for (let round = 0; round < 6; round++) {
      const start = performance.now(), pixels = kernel.render_rgba(round % 2 ? afterOptions : beforeOptions)
      times.push({ variant: round % 2 ? 'after' : 'before', milliseconds: performance.now() - start })
      assert.deepEqual(pixels, reference)
    }
    const wrong = kernel.render_rgba(opts({ ...view, zoom: zoom * .5 }))
    assert.notEqual(hash(wrong), hash(reference), 'negative control must detect a wrong final zoom')
    await writeFile(join(output, `exact-${zoom}.rgba`), reference)
    cpu.push({ nodes: 3200, zoom, width: 256, height: 192, beforeAdmissionMs: before.delayMs,
      afterAdmissionMs: after.delayMs, pixelSha256: hash(reference), wrongZoomSha256: hash(wrong), times })
    console.log(JSON.stringify({ stage: 'CPU raster', ...cpu.at(-1) }))
  }
  // Execute all admitted sample cameras for a dense burst whose old quiet
  // window would queue one unnecessary terminal preview. This is real CPU
  // raster work, separately timed from the deterministic admission clock.
  const finalView = camera(32, 5.25, 7.125)
  const inputs = Array.from({ length: 28 }, (_, index) => ({ at: (index + 1) * 1000 / 120,
    view: index === 27 ? finalView : camera(.1 * 320 ** ((index + 1) / 28), index / 16, -index / 32) }))
  const sequences = { before: replay(Before, 120, inputs, finalView, true), after: replay(After, 120, inputs, finalView, true),
    experimental: replay(Experimental, 120, inputs, finalView, true) }
  assert.deepEqual(sequences.after.samples.map(({ active, view }) => ({ active, view })),
    sequences.before.samples.map(({ active, view }) => ({ active, view })))
  assert.ok(sequences.after.samples.length <= sequences.before.samples.length)
  assert.ok(sequences.experimental.samples.length < sequences.before.samples.length)
  const expectedHash = cpu.find(row => row.zoom === 32).pixelSha256
  for (let round = 0; round < 4; round++) {
    for (const variant of round % 2 ? ['experimental', 'after', 'before'] : ['before', 'after', 'experimental']) {
      kernel.load_document(fixture)
      const samples = [], started = performance.now()
      for (const sample of sequences[variant].samples) {
        const before = performance.now(), pixels = kernel.render_rgba(JSON.stringify({ pageId: 'page', width: 256, height: 192,
          view: sample.view, transparent: false, grid: false, rasterProfile: 'analytic' }))
        samples.push({ preview: sample.active, rasterMs: performance.now() - before, pixelSha256: hash(pixels) })
      }
      assert.equal(samples.at(-1).pixelSha256, expectedHash)
      rasterWork.push({ variant, round, nodes: 3200, rasterCount: samples.length,
        rasterWallMs: performance.now() - started, admissionDelayMs: sequences[variant].delayMs, samples })
    }
  }
  console.log(JSON.stringify({ stage: 'actual CPU burst work', rasterWork }))

  const shortResume = shortResumes.find(row => row.hz === 120 && row.bursts === 13)
  const expectedFinal = cpu.find(row => row.zoom === 32).pixelSha256
  for (let round = 0; round < 4; round++) {
    for (const variant of round % 2 ? ['after', 'before'] : ['before', 'after']) {
      kernel.load_document(fixture)
      const samples = [], started = performance.now()
      for (const sample of shortResume[variant].samples) {
        const before = performance.now(), pixels = kernel.render_rgba(JSON.stringify({ pageId: 'page', width: 256, height: 192,
          view: sample.view, transparent: false, grid: false, rasterProfile: 'analytic' }))
        samples.push({ preview: sample.active, rasterMs: performance.now() - before, pixelSha256: hash(pixels) })
      }
      assert.equal(samples.at(-1).pixelSha256, expectedFinal)
      shortResumeRasterWork.push({ variant, round, nodes: 3200, rasterCount: samples.length,
        rasterWallMs: performance.now() - started, admissionDelayMs: shortResume[variant].delayMs, samples })
    }
  }
  console.log(JSON.stringify({ stage: 'actual CPU short-resume work', shortResumeRasterWork }))
} finally { kernel.free() }
const result = { status: 'passed', scope: 'Production scheduling replay plus actual WASM CPU pixels; no browser/GPU/Electron/display timing claims',
  baselineCommit, configuration: { after: 'default conservative160ms; normal React hook', experimental: 'constructor adaptiveQuiet:true only; not enabled in UI' },
  traces: traces.length, admission, experimentalAdmission, cpu, rasterWork, shortResumes, shortResumeRasterWork,
  manifest: { runtime: process.version, baselineSourceSha256: hash(baselineSource), sourceSha256: hash(source), wasmSha256: hash(wasm),
    fontSha256: hash(font), fixtureSha256: hash(fixture), runnerSha256: hash(await readFile(fileURLToPath(import.meta.url))) } }
await writeFile(join(output, 'traces.json'), JSON.stringify(traces))
await writeFile(join(output, 'results.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify({ status: 'passed', output }))
