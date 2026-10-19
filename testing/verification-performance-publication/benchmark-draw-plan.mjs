// Pure production CPU planning. No WebGL device, browser, WASM or timing mocks.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { compositeDrawPlan as after } from '../../frontend/design-client/src/kernel/gpu/composite-draw-plan.ts'
const source = readFileSync(new URL('./composite-draw-plan.before.ts', import.meta.url), 'utf8')
assert.equal(createHash('sha256').update(source).digest('hex'), 'c2299336e926a8c83ca3daeb92fde2db5b74a6770c4cf071d5c5ea84eae53f55')
const { compositeDrawPlan: before } = await import(`data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`)
const mode = process.argv[2]
assert.ok(mode === 'before' || mode === 'after', 'Pass before or after')
const run = mode === 'before' ? before : after
const camera = { x: .125, y: -.375, zoom: 32 }
function grid(columns, rows, layer = 1, scale = 64, offset = 0) {
  return Array.from({ length: columns * rows }, (_, i) => ({
    tile: { key: `${layer}-${i}`, serial: layer * 1000 + i, bytes: new Uint8Array(),
      x: i % columns * 512 - 1 + offset, y: Math.floor(i / columns) * 512 - 1,
      width: 514, height: 514, zoom: scale, phaseX: .25, phaseY: .75 },
    active: true, layer, gutter: 1,
  }))
}
const fullscreen = (id, layer, blend = false) => ({
  tile: { key: `cover-${id}`, serial: id, bytes: new Uint8Array(), x: 0, y: 0, width: 16, height: 16, zoom: 1 },
  active: true, layer, gutter: 0, blend, placement: { left: 0, top: 0, width: 2048, height: 2048 },
})
const cases = [
  { name: 'single-tile-control', items: grid(1, 1), width: 256, height: 256 },
  { name: '1080p-retina-40-tiles', items: grid(8, 5), width: 1920, height: 1080 },
  { name: '64-disjoint-residents', items: grid(8, 8), width: 2048, height: 2048 },
  { name: '4k-retina-135-tiles', items: grid(15, 9), width: 3840, height: 2160 },
  { name: '256-disjoint-stress', items: grid(16, 16), width: 4096, height: 4096 },
  { name: 'progressive-history-and-blends', items: [fullscreen(1, 0), ...grid(8, 8),
    ...grid(4, 4, 2, 32, 170).map((i, k) => ({ ...i, clip: { left: 120 + k * 13.125, top: 80, width: 800, height: 700 } })),
    ...grid(6, 6, 3).map(i => ({ ...i, blend: true }))], width: 2048, height: 2048 },
  { name: 'opaque-overlap-128-control', items: Array.from({ length: 128 }, (_, i) => fullscreen(i, i)), width: 2048, height: 2048 },
  { name: 'transparent-overlap-128-control', items: Array.from({ length: 128 }, (_, i) => fullscreen(i, i, true)), width: 2048, height: 2048 },
]
const results = []
let witness = 0
for (const scenario of cases) {
  const { items, width, height } = scenario
  assert.deepStrictEqual(after(items, camera, width, height), before(items, camera, width, height))
  for (let i = 0; i < 200; i++) witness += run(items, camera, width, height).length
  // Fixed iterations per case are the same in every old/new process.
  const iterations = items.length >= 200 ? 100 : items.length >= 100 ? 300 : items.length >= 30 ? 800 : 25000
  const samplesMs = []
  for (let sample = 0; sample < 7; sample++) {
    const start = performance.now()
    for (let i = 0; i < iterations; i++) witness += run(items, camera, width, height).length
    samplesMs.push((performance.now() - start) / iterations)
  }
  const sorted = samplesMs.slice().sort((a, b) => a - b)
  results.push({ name: scenario.name, items: items.length, draws: run(items, camera, width, height).length,
    iterations, samplesMs, medianMs: sorted[3], worstSampleMs: sorted[6] })
}
console.log(JSON.stringify({ mode, node: process.version, platform: process.platform, architecture: process.arch,
  beforeSha256: createHash('sha256').update(source).digest('hex'),
  afterSha256: createHash('sha256').update(readFileSync(new URL('../../frontend/design-client/src/kernel/gpu/composite-draw-plan.ts', import.meta.url))).digest('hex'),
  timing: 'CPU compositeDrawPlan only; independent process, 200 warmups then seven fixed-iteration batches', witness, results }, null, 2))
