// Run after building the real kernel: bun scripts/benchmark-picking.ts
// Warm CPU/geometry timings only; not browser frame rate or input latency.
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import { initializePicking } from '../src/kernel/picking.ts'
import { VectorEngine } from '../src/generated/design-kernel/design_kernel.js'
import { Editor } from '../src/engine.ts'
import { SpatialIndex } from '../src/geometry.ts'
import { blank, node, type DesignNode } from '../src/model.ts'
await initializePicking({
  wasm: readFileSync(new URL('../public/kernel/design_kernel_bg.wasm', import.meta.url)),
  font: readFileSync(new URL('../public/fonts/NotoSansSC.ttf', import.meta.url)),
})
function measure(f: () => unknown, repeat = 11) {
  f()
  const samples = []
  for (let i = 0; i < repeat; i++) {
    const start = performance.now()
    f()
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  return {
    medianMs: samples[Math.floor(samples.length / 2)],
    p95Ms: samples[Math.ceil(samples.length * 0.95) - 1],
    samples,
  }
}
const results = []
for (const [depth, leaves] of [
  [1, 32],
  [8, 128],
  [24, 256],
]) {
  const doc = blank()
  let parent: DesignNode | undefined
  for (let i = 0; i < depth; i++) {
    const frame = node('frame', 0, 0, 100, 100)
    frame.radii = [4, 4, 4, 4]
    frame.fills = []
    doc.nodes[frame.id] = frame
    ;(parent?.children ?? doc.pages[0].children).push(frame.id)
    const mask = node('rectangle', 0, 0, 100, 100)
    mask.mask = true
    mask.locked = true
    mask.radii = [4, 4, 4, 4]
    doc.nodes[mask.id] = mask
    frame.children.push(mask.id)
    parent = frame
  }
  for (let i = 0; i < leaves; i++) {
    const n = node('ellipse', 0, 0, 100, 100)
    doc.nodes[n.id] = n
    parent.children.push(n.id)
  }
  const editor = new Editor(doc)
  editor.set({ view: { x: 0.125, y: 0.375, zoom: 2 } })
  const index = new SpatialIndex(editor.entries()),
    point = { x: 8, y: 8 }
  const indexedHit = measure(() => editor.hit(point, true, index))
  const fullHit = measure(() => editor.hit(point, true), 5)
  const core = new VectorEngine()
  core.load_document(JSON.stringify(doc))
  const options = JSON.stringify({
    pageId: doc.pages[0].id,
    width: 256,
    height: 256,
    transparent: true,
    view: { x: 0.125, y: 0.375, zoom: 2 },
    rasterProfile: 'analytic',
  })
  const render = measure(() => core.render_rgba(options), 5)
  const hash = createHash('sha256').update(core.render_rgba(options)).digest('hex')
  const stats = JSON.parse(core.stats())
  core.free()
  results.push({
    depth,
    leaves,
    nodes: Object.keys(doc.nodes).length,
    indexedHit,
    fullHit,
    render,
    hash,
    stats,
  })
}
console.log(
  JSON.stringify(
    {
      runtime: process.versions,
      mode: 'real WASM CPU; warm repeat; indexed versus full frontend hit; 256x256 analytic render',
      memory: process.memoryUsage(),
      results,
    },
    null,
    2,
  ),
)
