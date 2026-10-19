/// <reference types="node" />
import { beforeAll, expect, test } from 'vitest'
import { readFile } from 'node:fs/promises'
import {
  initializePicking,
  kernelHit,
  kernelStrokePaths,
  kernelStrokeHandles,
} from './kernel/picking'
import { strokeFixture } from './stroke-fixtures'
import { Editor } from './engine'
import { validateDocument, node, stroke, blank } from './model'
import { profilePreset } from './stroke-profile'
import { svgSource } from './export'
import { geometry_json, VectorEngine } from './generated/design-kernel/design_kernel'
beforeAll(async () =>
  initializePicking({
    wasm: new Uint8Array(
      await readFile(new URL('../public/kernel/design_kernel_bg.wasm', import.meta.url)),
    ),
    font: new Uint8Array(
      await readFile(new URL('../public/fonts/NotoSansSC.ttf', import.meta.url)),
    ),
  }),
)
test('profile document survives JSON round trip and native WASM validation', () => {
  const { doc } = strokeFixture()
  expect(validateDocument(JSON.parse(JSON.stringify(doc)))).toEqual(doc)
  const engine = new VectorEngine()
  expect(() => engine.load_document(JSON.stringify(doc))).not.toThrow()
  engine.free()
})
test('inspector edits, cancellation and undo redo retain width controls', () => {
  const { doc, ids } = strokeFixture(),
    e = new Editor(doc),
    id = ids[0]
  e.update([id], (n) => {
    n.strokes[0].widthProfile![1].left = 2
  })
  expect(e.state.doc.nodes[id].strokes[0].widthProfile![1].left).toBe(2)
  e.undo()
  expect(e.state.doc.nodes[id].strokes[0].widthProfile![1].left).toBe(1)
  e.redo()
  expect(e.state.doc.nodes[id].strokes[0].widthProfile![1].left).toBe(2)
  e.begin('drag')
  const strokes = structuredClone(e.state.doc.nodes[id].strokes)
  strokes[0].widthProfile![1].left = 3
  e.preview({ [id]: { strokes } })
  e.cancel()
  expect(e.state.doc.nodes[id].strokes[0].widthProfile![1].left).toBe(2)
})
test('invalid profiles are rejected atomically in editor and import', () => {
  const { doc, ids } = strokeFixture(),
    e = new Editor(doc),
    before = e.state.doc
  e.update([ids[0]], (n) => {
    n.strokes[0].widthProfile![1].position = 0
  })
  expect(e.state.doc).toBe(before)
  doc.nodes[ids[0]].strokes[0].widthProfile![1].left = 5
  expect(() => validateDocument(doc)).toThrow()
})
test('wide stroke edges outside the centerline bounds remain selectable', () => {
  const d = blank(),
    n = node('line', 50, 80, 100, 1)
  n.fills = []
  n.strokes = [
    { ...stroke('#000000', 20), cap: 'butt', widthProfile: [{ position: 0, left: 4, right: 4 }] },
  ]
  d.nodes[n.id] = n
  d.pages[0].children = [n.id]
  const e = new Editor(d)
  e.set({ view: { x: 0, y: 0, zoom: 1 } })
  expect(e.hit({ x: 100, y: 115 })).toBe(n.id)
  expect(e.hit({ x: 100, y: 135 })).toBeNull()
})
test('SVG serializes the Rust union path with stroke paint applied once', () => {
  const { doc, ids } = strokeFixture(),
    n = doc.nodes[ids[0]],
    path = kernelStrokePaths(n)[0]
  const source = svgSource(doc, doc.pages[0].id).source
  expect(source).toContain(`d="${path}"`)
  expect(source).toContain('fill-rule="nonzero"')
  expect(source).not.toContain('stroke-width="38"')
})
test('handles follow arc length, use unit normals and update when geometry changes', () => {
  const { doc, ids } = strokeFixture(),
    n = doc.nodes[ids[0]],
    a = kernelStrokeHandles(n, 0)
  expect(a).toHaveLength(3)
  expect(Math.hypot(a[1].normal.x, a[1].normal.y)).toBeCloseTo(1)
  n.network!.edges[0].c1!.y -= 40
  const b = kernelStrokeHandles(n, 0)
  expect(b[1].point.y).not.toBe(a[1].point.y)
})
test('outline and hit testing use tapered coverage, including dashed gaps', () => {
  const n = node('vector', 0, 0, 100, 1)
  n.fills = []
  n.network = {
    fillRule: 'nonzero',
    vertices: [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 100, y: 0 },
    ],
    edges: [{ id: 'ab', from: 'a', to: 'b' }],
  }
  n.strokes = [
    {
      ...stroke('#000000', 20),
      cap: 'butt',
      dash: '10 10',
      widthProfile: profilePreset('grow', false),
    },
  ]
  expect(kernelHit(n, { x: 85, y: 7 }, 0)).toBe(true)
  expect(kernelHit(n, { x: 15, y: 0 }, 0)).toBe(false)
  expect(kernelHit(n, { x: 5, y: 4 }, 0)).toBe(false)
  const cs = JSON.parse(geometry_json(JSON.stringify({ operation: 'outline', nodes: [n] })))
  expect(cs[0]).toHaveLength(5)
})
test('closed endpoint mismatches fail in both frontend and Rust WASM', () => {
  const { doc, ids } = strokeFixture()
  doc.nodes[ids[3]].strokes[0].widthProfile = profilePreset('taper', false)
  expect(() => validateDocument(doc)).toThrow()
  const e = new VectorEngine()
  expect(() => e.load_document(JSON.stringify(doc))).toThrow()
  e.free()
})
