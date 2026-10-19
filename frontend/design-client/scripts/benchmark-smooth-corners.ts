// Warm real-WASM CPU geometry/render timings. Not browser FPS or input latency.
// Optional WASM_PATH lets the same script compare saved pre-change builds.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import {
  initSync,
  VectorEngine,
  hit_test_device_json,
} from '../src/generated/design-kernel/design_kernel.js'
const wasm = readFileSync(
  process.env.WASM_PATH ?? new URL('../public/kernel/design_kernel_bg.wasm', import.meta.url),
)
initSync({ module: wasm })
function measure(f: () => unknown) {
  for (let i = 0; i < 3; i++) f()
  const samples = []
  for (let i = 0; i < 11; i++) {
    const start = performance.now()
    f()
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  return { p50Ms: samples[5], p95Ms: samples[10], samples }
}
const results = []
for (const [radius, zoom, profile] of [
  [1, 1, 'analytic'],
  [20, 1, 'analytic'],
  [2000, 32, 'analytic'],
  [2000, 32, 'figma'],
] as const) {
  const x = 0.866,
    y = (1 - x ** 5) ** (1 / 5),
    px = radius * (1 + x),
    py = radius * (1 - y)
  const n = {
    id: 'n',
    kind: 'rectangle',
    width: radius * 2,
    height: radius * 2,
    radii: [radius, radius, radius, radius],
    smoothing: 1,
    fills: [{ kind: 'solid', color: '#000000' }],
  }
  const doc = {
    schemaVersion: 1,
    id: 'd',
    name: 'smooth benchmark',
    pages: [{ id: 'p', name: 'p', background: '#ffffff', children: ['n'] }],
    nodes: { n },
  }
  const core = new VectorEngine()
  core.load_document(JSON.stringify(doc))
  const options = JSON.stringify({
    pageId: 'p',
    width: 64,
    height: 64,
    transparent: true,
    rasterProfile: profile,
    view: { zoom, x: 31.5 - px * zoom, y: 31.5 - py * zoom },
  })
  const node = JSON.stringify(n),
    matrix = JSON.stringify([zoom, 0, 0, zoom, 0, 0])
  const render = measure(() => core.render_rgba(options)),
    pick = measure(() => hit_test_device_json(node, matrix, px * zoom - 0.1, py * zoom + 0.1, 0))
  const pixels = core.render_rgba(options),
    hash = createHash('sha256').update(pixels).digest('hex'),
    stats = JSON.parse(core.stats())
  results.push({ radius, zoom, profile, render, pick, hash, stats })
  core.free()
}
console.log(
  JSON.stringify(
    {
      runtime: process.versions,
      wasmSha256: createHash('sha256').update(wasm).digest('hex'),
      memory: process.memoryUsage(),
      results,
    },
    null,
    2,
  ),
)
