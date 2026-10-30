import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { blank, node, paint } from '../model'
import { VectorEngine } from '../generated/design-kernel/design_kernel'

function engineWithDocument() {
  const renderer = new VectorEngine()
  renderer.load_font(
    new Uint8Array(readFileSync(new URL('../../public/fonts/NotoSansSC.ttf', import.meta.url))),
  )
  const doc = blank('Tiled frame assembly')
  const frame = node('frame', 0, 0, 900, 700)
  frame.fills = [paint('#ffffff')]
  const rect = node('rectangle', 32, 32, 700, 560)
  rect.fills = [paint('#3366aa')]
  const inner = node('ellipse', 200, 180, 320, 220)
  inner.fills = [paint('#dd9944')]
  frame.children = [rect.id, inner.id]
  doc.nodes = { [frame.id]: frame, [rect.id]: rect, [inner.id]: inner }
  doc.pages[0].children = [frame.id]
  renderer.load_document(JSON.stringify(doc))
  return { renderer, pageId: doc.pages[0].id }
}

const optionsFor =
  (pageId: string) =>
  (view: { x: number; y: number; zoom: number }) =>
  JSON.stringify({
    pageId,
    width: 512,
    height: 384,
    view,
    transparent: false,
    rasterProfile: 'analytic',
  })

test('bucket-snapped zoom assembles byte-identically to the full render', () => {
  const { renderer: engine, pageId } = engineWithDocument()
  const options = optionsFor(pageId)
  try {
    const direct = engine.render_rgba(options({ x: -100, y: -60, zoom: 1 }))
    const assembled = engine.assemble_tiled_rgba(options({ x: -100, y: -60, zoom: 1 }), 'null')
    expect(assembled.byteLength).toBe(512 * 384 * 4)
    expect(Array.from(assembled)).toEqual(Array.from(direct))
  } finally {
    engine.free()
  }
})

test('off-bucket zoom assembles the bucket residency without a full raster', () => {
  const { renderer: engine, pageId } = engineWithDocument()
  const options = optionsFor(pageId)
  try {
    const cold = engine.assemble_tiled_rgba(options({ x: 0, y: 0, zoom: 0.9 }), 'null')
    expect(cold.byteLength).toBe(512 * 384 * 4)
    expect(cold.some(byte => byte !== 0)).toBe(true)
    // In-bucket zoom change: served from residency, no error, no size drift.
    const warm = engine.assemble_tiled_rgba(options({ x: 0, y: 0, zoom: 0.85 }), 'null')
    expect(warm.byteLength).toBe(512 * 384 * 4)
    // Deep-interior probe stays byte-exact against a direct render at the
    // same zoom (constant regions survive premultiplied resampling).
    const direct = engine.render_rgba(options({ x: 0, y: 0, zoom: 0.9 }))
    for (const [x, y] of [[300, 200], [40, 40]] as const) {
      const i = (y * 512 + x) * 4
      expect(Array.from(cold.slice(i, i + 4))).toEqual(Array.from(direct.slice(i, i + 4)))
    }
  } finally {
    engine.free()
  }
})

test('returning to the bucket scale after an off-bucket zoom stays byte-exact', () => {
  const { renderer: engine, pageId } = engineWithDocument()
  const options = optionsFor(pageId)
  try {
    engine.assemble_tiled_rgba(options({ x: -48, y: -24, zoom: 0.9 }), 'null')
    const assembled = engine.assemble_tiled_rgba(options({ x: -48, y: -24, zoom: 1 }), 'null')
    const direct = engine.render_rgba(options({ x: -48, y: -24, zoom: 1 }))
    expect(Array.from(assembled)).toEqual(Array.from(direct))
  } finally {
    engine.free()
  }
})
