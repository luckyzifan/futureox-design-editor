import { beforeAll, expect, test } from 'vitest'
import { readFile } from 'node:fs/promises'
import { VectorEngine } from './generated/design-kernel/design_kernel'
import { blank, node, type DesignNode } from './model'
import { kernelHitWorld } from './kernel/picking'
import { Editor } from './engine'

let font: Uint8Array
beforeAll(async () => {
  font = new Uint8Array(await readFile(new URL('../public/fonts/NotoSansSC.ttf', import.meta.url)))
})
function fixture(n: DesignNode) {
  const doc = blank()
  doc.nodes[n.id] = n
  doc.pages[0].children = [n.id]
  return doc
}
function options(pageId: string, zoom = 1, x = 0, y = 0) {
  return {
    pageId,
    width: 64,
    height: 64,
    view: { zoom, x, y },
    transparent: true,
    grid: false,
    rasterProfile: 'analytic',
  }
}
function render(n: DesignNode, zoom = 1, x = 0, y = 0) {
  const doc = fixture(n),
    engine = new VectorEngine()
  try {
    if (n.kind === 'text') engine.load_font(font)
    engine.load_document(JSON.stringify(doc))
    const pixels = engine.render_rgba(JSON.stringify(options(doc.pages[0].id, zoom, x, y)))
    return { pixels, segments: JSON.parse(engine.stats()).pathSegments }
  } finally {
    engine.free()
  }
}
test('real WASM zoom rerasterizes curves rather than magnifying a previous bitmap', () => {
  const n = node('ellipse', 0, 0, 1, 1),
    doc = fixture(n),
    engine = new VectorEngine()
  try {
    engine.load_document(JSON.stringify(doc))
    const low = engine.render_rgba(JSON.stringify(options(doc.pages[0].id)))
    const lowSegments = JSON.parse(engine.stats()).pathSegments
    const high = engine.render_rgba(JSON.stringify(options(doc.pages[0].id, 32)))
    expect(JSON.parse(engine.stats()).pathSegments).toBeGreaterThan(lowSegments)
    const baked = node('ellipse', 0, 0, 32, 32)
    expect(high).toEqual(render(baked).pixels)
    let different = 0
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 32; x++) if (high[(y * 64 + x) * 4 + 3] !== low[3]) different++
    expect(different).toBeGreaterThan(900)
    engine.render_rgba(JSON.stringify(options(doc.pages[0].id)))
    expect(engine.render_rgba(JSON.stringify(options(doc.pages[0].id, 32)))).toEqual(high)
  } finally {
    engine.free()
  }
})
test('visible magnified tiny ellipse is picked at the same world position', () => {
  const n = node('ellipse', 0, 0, 0.001, 0.001)
  n.transform = [1000, 0, 0, 1000, 0, 0]
  const result = render(n, 32)
  expect(result.pixels[(25 * 64 + 25) * 4 + 3]).toBe(255)
  expect(kernelHitWorld(n, { x: 0.8, y: 0.8 }, n.transform, 32)).toBe(true)
  const editor = new Editor(fixture(n))
  editor.set({ view: { x: 100, y: -70, zoom: 32 } })
  expect(editor.hit({ x: 0.8, y: 0.8 })).toBe(n.id)
  expect(editor.hit({ x: 0.97, y: 0.97 })).toBe(null)
})
test('WASM picking uses a circular CSS-pixel halo under extreme nonuniform transforms', () => {
  const n = node('line', 0, 0, 100, 1)
  n.strokes[0].width = 2
  n.strokes[0].cap = 'butt'
  n.transform = [0.01, 0, 0, 100, 0, 0]
  const editor = new Editor(fixture(n))
  editor.set({ view: { x: 0, y: 0, zoom: 1 } })
  expect(editor.hit({ x: 4.5, y: 50 })).toBe(n.id)
  expect(editor.hit({ x: 6.5, y: 50 })).toBe(null)
})
test('large positive and negative document origins retain the same final CPU pixels', () => {
  const base = node('ellipse', 0, 0, 1, 1),
    expected = render(base, 32, 3.25, 5.125).pixels
  for (const at of [-9999999.125, 9999999.125]) {
    const moved = node('ellipse', at, at, 1, 1)
    expect(render(moved, 32, 3.25 - at * 32, 5.125 - at * 32).pixels).toEqual(expected)
    expect(kernelHitWorld(moved, { x: at + 0.8, y: at + 0.8 }, moved.transform, 32)).toBe(true)
  }
})
test('text remains a curve outline and is resampled at the requested view scale', () => {
  const n = node('text', 0, 0, 4, 4)
  n.text = 'O'
  n.fontSize = 1
  const engine = new VectorEngine()
  try {
    engine.load_font(font)
    expect(engine.svg_paths(JSON.stringify(n))).toMatch(/[CQ]/)
  } finally {
    engine.free()
  }
  const high = render(n, 32),
    low = render(n)
  const scaled = { ...n, transform: [32, 0, 0, 32, 0, 0] as DesignNode['transform'] }
  expect(high.pixels).toEqual(render(scaled).pixels)
  expect(high.segments).toBeGreaterThan(low.segments)
})
