// Real-WASM CPU picking. WASM_PATH compares saved builds with identical inputs.
// SNAPSHOT=1 records deterministic per-point outcomes; otherwise warm batch timings.
// No browser, GPU, FPS, peak-memory or input-to-display measurement.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { initializePicking } from '../src/kernel/picking.ts'
import {
  hit_test_device_json,
  hit_test_fill_device_json,
} from '../src/generated/design-kernel/design_kernel.js'
import { Editor } from '../src/engine.ts'
import { SpatialIndex, apply } from '../src/geometry.ts'
import { blank, node, type Matrix } from '../src/model.ts'
const wasm = readFileSync(
  process.env.WASM_PATH ?? new URL('../public/kernel/design_kernel_bg.wasm', import.meta.url),
)
await initializePicking({
  wasm,
  font: readFileSync(new URL('../public/fonts/NotoSansSC.ttf', import.meta.url)),
})
function shape(radius: number) {
  const n = node('rectangle', 0, 0, radius * 2, radius * 2)
  n.id = 'shape'
  n.radii = [radius, radius, radius, radius]
  n.smoothing = 1
  return n
}
function measure(f: () => unknown, batch = 8) {
  for (let i = 0; i < 5; i++) f()
  const samples = []
  for (let i = 0; i < 31; i++) {
    const start = performance.now()
    for (let j = 0; j < batch; j++) f()
    samples.push((performance.now() - start) / batch)
  }
  samples.sort((a, b) => a - b)
  return { p50Ms: samples[15], p95Ms: samples[29], batch, samples }
}
function nested(depth: number) {
  const doc = blank()
  doc.id = 'doc'
  doc.pages[0].id = 'page'
  let children = doc.pages[0].children
  for (let i = 0; i < depth; i++) {
    const frame = shape(2000)
    frame.id = `frame-${i}`
    frame.kind = 'frame'
    frame.clip = true
    frame.fills = []
    const mask = shape(2000)
    mask.id = `mask-${i}`
    mask.mask = true
    mask.locked = true
    children.push(frame.id)
    doc.nodes[frame.id] = frame
    frame.children.push(mask.id)
    doc.nodes[mask.id] = mask
    children = frame.children
  }
  const leaf = node('rectangle', 0, 0, 4000, 4000)
  leaf.id = 'leaf'
  children.push(leaf.id)
  doc.nodes[leaf.id] = leaf
  const editor = new Editor(doc)
  editor.set({ view: { x: 0.125, y: -0.375, zoom: 32 } })
  return { editor, index: new SpatialIndex(editor.entries()) }
}
const x = 0.866,
  y = (1 - x ** 5) ** 0.2
const point = { x: 2000 * (1 + x) - 0.1 / 32, y: 2000 * (1 - y) + 0.1 / 32 }
const results: unknown[] = []
if (process.env.SNAPSHOT) {
  const matrices: Matrix[] = [
    [32, 0, 0, 32, 0.125, -0.375],
    [-32, 8, 15, 4, 0.125, -0.375],
    [0.01, 0, 20, 32, -100, 40],
    [32, 8, 15, 4, 3e9 + 0.125, -3e9 - 0.375],
    [-32, 8, 15, 4, -3e9 - 0.125, 3e9 + 0.375],
    [32, 0, 32, 0, 0, 0],
  ]
  for (const radius of [0, 1, 2000])
    for (const m of matrices) {
      const n = JSON.stringify(shape(radius)),
        matrix = JSON.stringify(m)
      let bits = ''
      for (let quadrant = 0; quadrant < 4; quadrant++)
        for (let j = 0; j <= 24; j++) {
          const x = j / 24,
            y = (1 - x ** 5) ** 0.2
          const [a, b] =
            quadrant === 0 ? [x, -y] : quadrant === 1 ? [y, x] : quadrant === 2 ? [-x, y] : [-y, -x]
          const p = apply(m, { x: radius * (1 + a), y: radius * (1 + b) })
          for (const offset of [0, -0.02, 0.02, -5, 5]) {
            const px = p.x + offset,
              py = p.y - offset
            bits += Number(hit_test_device_json(n, matrix, px, py, 5))
            bits += Number(hit_test_fill_device_json(n, matrix, px, py))
          }
        }
      results.push({ radius, matrix: m, comparisons: bits.length, bits })
    }
  for (const align of ['center', 'inside', 'outside'])
    for (const cap of ['butt', 'round', 'square']) {
      const n = shape(20)
      n.fills = []
      n.strokes = [
        {
          width: 3,
          align,
          cap,
          join: 'round',
          dash: '7,3',
          dashOffset: 2.25,
          visible: true,
          opacity: 1,
          paint: { kind: 'solid', color: '#000000', visible: true, opacity: 1 },
          widthProfile: [
            { position: 0, left: 1, right: 1 },
            { position: 0.5, left: 3, right: 2 },
            { position: 1, left: 1, right: 1 },
          ],
        },
      ] as typeof n.strokes
      const json = JSON.stringify(n),
        m: Matrix = [-4, 1, 2, 0.5, 0.125, -0.375],
        matrix = JSON.stringify(m)
      let bits = ''
      for (let y = -2; y <= 10; y++)
        for (let x = -2; x <= 10; x++) {
          const p = apply(m, { x: x * 4, y: y * 4 })
          for (const halo of [0, 5])
            bits += Number(hit_test_device_json(json, matrix, p.x, p.y, halo))
        }
      results.push({ align, cap, comparisons: bits.length, bits })
    }
  for (const depth of [1, 8]) {
    const { editor, index } = nested(depth),
      hits = []
    for (let j = 0; j < 25; j++) {
      const p = { x: point.x + (j - 12) / 32, y: point.y }
      hits.push(editor.hit(p, true, index) ?? null)
    }
    results.push({ depth, hits })
  }
} else {
  for (const radius of [1, 20, 2000])
    for (const outside of [false, true]) {
      const n = JSON.stringify(shape(radius)),
        zoom = radius === 2000 ? 32 : 1
      const matrix = JSON.stringify([zoom, 0, 0, zoom, 0, 0]),
        sign = outside ? 1 : -1
      const px = radius * (1 + x) * zoom + sign * 0.1,
        py = radius * (1 - y) * zoom - sign * 0.1
      results.push({
        radius,
        zoom,
        outside,
        selection: measure(() => hit_test_device_json(n, matrix, px, py, 5)),
        ancestor: measure(() => hit_test_fill_device_json(n, matrix, px, py)),
      })
    }
  for (const depth of [1, 8]) {
    const { editor, index } = nested(depth)
    results.push({
      depth,
      nestedHit: measure(() => editor.hit(point, true, index), 2),
      result: editor.hit(point, true, index),
    })
  }
}
console.log(
  JSON.stringify(
    {
      runtime: process.versions,
      wasmSha256: createHash('sha256').update(wasm).digest('hex'),
      mode: process.env.SNAPSHOT
        ? 'point-by-point snapshot'
        : '5 warmups, 31 samples, batched per-query ms; nearest-rank p95',
      results,
    },
    null,
    2,
  ),
)
