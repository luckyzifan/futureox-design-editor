import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { VectorEngine } from './generated/design-kernel/design_kernel'
import {
  blank,
  node,
  defaultSizing,
  defaultTextStyle,
  defaultLayout,
  type DesignNode,
  type DesignDocument,
  type Matrix,
} from './model'
import { kernelLayout, kernelTextLayout, kernelHitWorld, kernelSvgPaths } from './kernel/picking'
import { apply } from './geometry'

function text(value = '中文AB', indent = 12.375) {
  const n = node('text', 0, 0, 500, 30)
  n.text = value
  n.fontSize = 20
  n.textStyle = { ...defaultTextStyle(), wrap: true, paragraphIndent: indent }
  n.sizing = { ...defaultSizing(), width: 'hug', height: 'hug' }
  return n
}
function document(n: DesignNode) {
  const d = blank('Indent')
  d.schemaVersion = 4
  d.nodes = { [n.id]: n }
  d.pages[0].children = [n.id]
  return d
}
function resolve(n: DesignNode) {
  return kernelLayout(document(n)).nodes[n.id]
}
function reference(n: DesignNode) {
  const natural = kernelTextLayout({
    ...n,
    textStyle: { ...defaultTextStyle(), ...n.textStyle, paragraphIndent: 0, wrap: false },
  })
  return {
    ...n,
    sizing: undefined,
    width: natural.width + (n.textStyle?.paragraphIndent || 0),
    height: natural.height,
  }
}
function render(d: DesignDocument, zoom: number) {
  const engine = new VectorEngine()
  try {
    engine.load_font(
      new Uint8Array(readFileSync(new URL('../public/fonts/NotoSansSC.ttf', import.meta.url))),
    )
    engine.load_document(JSON.stringify(d))
    return engine.render_rgba(
      JSON.stringify({
        pageId: d.pages[0].id,
        width: 400,
        height: 140,
        view: { x: 0.125, y: 0.375, zoom },
        transparent: true,
        rasterProfile: 'analytic',
      }),
    )
  } finally {
    engine.free()
  }
}

test('real WASM resolves positive-indent Hug to the same glyphs and outlines as independent fixed width', () => {
  for (const value of ['中文AB', 'e\u0301 中文\nAB', '\n中文\r\n']) {
    const n = text(value),
      fixed = reference(n),
      actual = resolve(n)
    expect(actual.width).toBeCloseTo(fixed.width, 10)
    expect(actual.height).toBeCloseTo(fixed.height, 10)
    expect(kernelTextLayout(actual)).toEqual(kernelTextLayout(fixed))
    expect(kernelSvgPaths(actual)).toEqual(kernelSvgPaths(fixed))
    expect(resolve(actual)).toEqual(actual)
  }
})

test('fractional indent keeps exact-fit Chinese on one line without hiding a genuine width deficit', () => {
  for (const spacing of [-1.25, 0, 0.375]) {
    const n = text('中文', 20.3)
    n.fontSize = 12
    n.textStyle = { ...defaultTextStyle(), ...n.textStyle, letterSpacing: spacing }
    const actual = resolve(n)
    expect(actual.width).toBeCloseTo(44.3 + spacing, 10)
    expect(kernelTextLayout(actual).lines).toHaveLength(1)
    expect(kernelTextLayout({ ...actual, width: actual.width - 1e-9 }).lines).toHaveLength(2)
  }
})

test('CPU text output and text-box picking match the fixed reference through repeated fractional zoom', () => {
  const n = text(),
    fixed = reference(n),
    actual = resolve(n)
  const matrix: Matrix = [-1, 0.125, 0.25, 1, 100.125, -20.375]
  for (const zoom of [0.25, 1, 1.375, 4, 1]) {
    const expected = render(document(fixed), zoom)
    expect(expected.some((byte, i) => i % 4 === 3 && byte > 0)).toBe(true)
    expect(render(document(n), zoom).every((byte, i) => byte === expected[i])).toBe(true)
    for (const [x, wanted] of [
      [fixed.width - 0.125, true],
      [fixed.width + 0.125, false],
    ] as const) {
      const p = apply(matrix, { x, y: fixed.height / 2 })
      // Text selection intentionally uses the resolved box, not glyph-ink hit testing.
      expect(kernelHitWorld(actual, p, matrix, zoom, 0)).toBe(wanted)
      expect(kernelHitWorld(actual, p, matrix, zoom, 0)).toBe(
        kernelHitWorld(fixed, p, matrix, zoom, 0),
      )
    }
  }
})

test('nested Hug preserves rich-text outlines and advances the clipped parent and sibling', () => {
  const n = text(),
    frame = node('frame'),
    sibling = node('rectangle', 0, 0, 9, 8)
  n.textRuns = [
    { start: 0, end: 2, fontSize: 28, weight: 600, color: '#cc2244', underline: true },
    { start: 2, end: 4, fontSize: 16, strikethrough: true },
  ]
  frame.children = [n.id, sibling.id]
  frame.clip = true
  frame.fills = []
  frame.layout = { ...defaultLayout(), mode: 'horizontal', padding: [3, 5, 7, 11], gap: 6 }
  frame.sizing = { ...defaultSizing(), width: 'hug', height: 'hug' }
  const d = document(frame)
  d.nodes[n.id] = n
  d.nodes[sibling.id] = sibling
  const actual = kernelLayout(d),
    fixed = reference(n)
  expect(actual.nodes[n.id].width).toBeCloseTo(fixed.width, 10)
  expect(actual.nodes[frame.id].width).toBeCloseTo(11 + fixed.width + 6 + 9 + 5, 10)
  expect(actual.nodes[frame.id].height).toBeCloseTo(3 + fixed.height + 7, 10)
  expect(actual.nodes[sibling.id].transform[4]).toBeCloseTo(11 + fixed.width + 6, 10)
  expect(kernelTextLayout(actual.nodes[n.id]).spans).toEqual(kernelTextLayout(fixed).spans)
  expect(kernelLayout(actual)).toEqual(actual)
})
