import { expect, test } from 'vitest'
import { colorFixture } from './color-fixture'
import { validateDocument } from './model'
import { validColor } from './color'
import { Editor } from './engine'
import { VectorEngine } from './generated/design-kernel/design_kernel'
test('ordinary SDR admits sRGB stop alpha without admitting extended ranges or other spaces', () => {
  for (const a of [0, .0001, .5, 1]) expect(validColor(`color(srgb .2 .4 .8 / ${a})`)).toBe(true)
  for (const value of ['color(srgb 2 0 0 / .5)', 'color(srgb -.1 0 0 / .5)',
    'color(srgb-linear 1 0 0 / .5)', 'color(display-p3 1 0 0 / .5)', 'color(srgb 1 0 0 / NaN)'])
    expect(validColor(value)).toBe(false)
})
test('managed schema survives edits, history and serialization without downgrading HDR', () => {
  const doc = colorFixture()
  validateDocument(doc)
  const editor = new Editor(doc)
  editor.change('亮度', (d) => {
    d.colorManagement!.peakLuminanceNits = 2000
  })
  expect(editor.state.doc.colorManagement!.peakLuminanceNits).toBe(2000)
  editor.undo()
  expect(editor.state.doc.colorManagement!.peakLuminanceNits).toBe(1000)
  editor.redo()
  const saved = JSON.parse(JSON.stringify(editor.state.doc))
  validateDocument(saved)
  expect(saved.colorManagement.peakLuminanceNits).toBe(2000)
  expect(saved.nodes[doc.pages[0].children[0]].fills[0].color).toBe('color(srgb-linear 4 0 0)')
})
test('invalid transfers, nonfinite colors and unversioned HDR are rejected', () => {
  const doc = colorFixture()
  doc.schemaVersion = 2
  expect(() => validateDocument(doc)).toThrow()
  for (const color of [
    'color(rec2100-pq 2 0 0)',
    'color(srgb NaN 0 0)',
    'color(srgb 1 0 0 / 2)',
    'color(unknown 1 0 0)',
  ])
    expect(validColor(color, true)).toBe(false)
  expect(validColor('color(display-p3 1 0 0 / 0.5)', true)).toBe(true)
  expect(validColor('color(display-p3 1 0 0)', false)).toBe(false)
})
test('actual WASM returns HDR and out-of-sRGB components and exports tagged 16-bit PNG', () => {
  const doc = colorFixture(),
    engine = new VectorEngine()
  engine.load_document(JSON.stringify(doc))
  const options = JSON.stringify({
    pageId: doc.pages[0].id,
    width: 320,
    height: 176,
    view: { x: 0, y: 0, zoom: 1 },
    rasterProfile: 'figma',
    grid: false,
    transparent: false,
  })
  const linear = engine.render_linear(options)
  expect(linear.reduce((a, b) => Math.max(a, b), -Infinity)).toBeGreaterThan(4)
  expect(linear.reduce((a, b) => Math.min(a, b), Infinity)).toBeLessThan(0)
  const bytes = engine.render_color_png(
    options,
    JSON.stringify({ space: 'rec2100-pq', toneMap: 'none' }),
  )
  expect(bytes[24]).toBe(16)
  let cicp: number[] = []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 8; i + 12 <= bytes.length; ) {
    const n = view.getUint32(i),
      type = new TextDecoder().decode(bytes.subarray(i + 4, i + 8))
    if (type === 'cICP') cicp = Array.from(bytes.subarray(i + 8, i + 8 + n))
    i += n + 12
  }
  expect(cicp).toEqual([9, 16, 0, 1])
  engine.free()
})
