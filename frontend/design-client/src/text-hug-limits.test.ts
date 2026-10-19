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
} from './model'
import { kernelLayout, kernelTextLayout, kernelHitWorld } from './kernel/picking'
function text() {
  const n = node('text', 0, 0, 500, 30)
  n.text = '中文中文中文'
  n.fontSize = 20
  n.textStyle = { ...defaultTextStyle(), wrap: true, paragraphIndent: 25, direction: 'ltr' }
  n.sizing = { ...defaultSizing(), width: 'hug', height: 'hug', maxWidth: 65 }
  return n
}
function document(n: DesignNode) {
  const d = blank('Limited text')
  d.schemaVersion = 4
  d.nodes = { [n.id]: n }
  d.pages[0].children = [n.id]
  return d
}
function nested(n: DesignNode, fill: boolean) {
  const outer = node('frame', 0, 0, 120, 300),
    inner = node('frame', 0, 0, 100, 300),
    sibling = node('rectangle', 0, 0, 9, 8)
  outer.fills = []
  inner.fills = []
  outer.children = [inner.id]
  outer.layout = { ...defaultLayout(), mode: 'vertical', padding: [10, 10, 10, 10] }
  outer.sizing = { ...defaultSizing(), height: 'hug' }
  inner.children = [n.id, sibling.id]
  inner.clip = true
  inner.layout = { ...defaultLayout(), mode: 'vertical', padding: [3, 5, 7, 11], gap: 6 }
  inner.sizing = { ...defaultSizing(), width: fill ? 'fill' : 'hug', height: 'hug' }
  const d = document(outer)
  d.nodes[inner.id] = inner
  d.nodes[n.id] = n
  d.nodes[sibling.id] = sibling
  return { d, outer, inner, sibling }
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
        width: 500,
        height: 600,
        view: { x: 0.125, y: 0.375, zoom },
        transparent: true,
        rasterProfile: 'analytic',
      }),
    )
  } finally {
    engine.free()
  }
}
test('real WASM constrained Hug height matches literal CJK advance and remains stable', () => {
  for (const initialWidth of [0.01, 65, 500]) {
    const n = text()
    n.width = initialWidth
    const actual = kernelLayout(document(n)),
      solved = actual.nodes[n.id],
      l = kernelTextLayout(solved)
    expect(solved.width).toBe(65)
    // Six 20px CJK advances: first line 2, continuation 3, final 1.
    expect(solved.height).toBe(81)
    expect(l.height).toBe(81)
    expect(l.lines.map((line) => [line.start, line.end])).toEqual([
      [0, 2],
      [2, 5],
      [5, 6],
    ])
    expect([l.glyphs[0].x, l.glyphs[2].x, l.glyphs[5].x]).toEqual([25, 0, 0])
    expect(kernelLayout(actual)).toEqual(actual)
  }
})
test('max width fractional boundary, sizing limits and non-reflow cases retain their contracts', () => {
  for (const spacing of [-1.25, 0, 0.375])
    for (const deficit of [0, 1e-9]) {
      const n = text()
      n.text = '中文'
      n.fontSize = 12
      n.textStyle = {
        ...defaultTextStyle(),
        ...n.textStyle,
        paragraphIndent: 20.3,
        letterSpacing: spacing,
      }
      n.sizing = { ...defaultSizing(), ...n.sizing, maxWidth: 44.3 + spacing - deficit }
      const solved = kernelLayout(document(n)).nodes[n.id]
      expect(solved.width).toBeCloseTo(44.3 + spacing - deficit, 10)
      expect(solved.height).toBeCloseTo(12 * 1.35 * (deficit ? 2 : 1), 10)
    }
  for (const [patch, style, w, h] of [
    [{}, { wrap: false }, 65, 27],
    [{ height: 'fixed' }, {}, 65, 30],
    [{ maxHeight: 40 }, {}, 65, 40],
    [{ minHeight: 100 }, {}, 65, 100],
    [{ maxWidth: 200 }, {}, 145, 27],
    [{ minWidth: 180, maxWidth: 200 }, {}, 180, 27],
  ] as const) {
    const n = text()
    n.sizing = { ...defaultSizing(), ...n.sizing, ...patch }
    n.textStyle = { ...defaultTextStyle(), ...n.textStyle, ...style }
    const solved = kernelLayout(document(n)).nodes[n.id]
    expect([solved.width, solved.height]).toEqual([w, h])
  }
})
test('rich text, paragraph spacing and signed indentation agree with independently fixed width', () => {
  for (const value of ['中文中文中文', '中文\n\n中文中文\r\n', 'e\u0301 中文AB中文'])
    for (const indent of [-12.375, 0, 12.375, 80]) {
      const n = text()
      n.text = value
      n.textStyle = {
        ...defaultTextStyle(),
        ...n.textStyle,
        paragraphIndent: indent,
        paragraphSpacing: 7.25,
        letterSpacing: 0.375,
      }
      n.textRuns = [
        { start: 0, end: 2, fontSize: 28, weight: 600, color: '#cc2244', underline: true },
      ]
      const fixed = { ...n, width: 65, sizing: undefined },
        expected = kernelTextLayout(fixed)
      const solved = kernelLayout(document(n)).nodes[n.id]
      expect(solved.width).toBe(65)
      expect(solved.height).toBeCloseTo(expected.height, 10)
      expect(kernelTextLayout(solved)).toEqual(expected)
    }
})
test('nested Hug and Fill parents, clipped CPU pixels and text-box hit area match fixed geometry', () => {
  for (const fill of [false, true]) {
    const n = text(),
      { d, outer, inner, sibling } = nested(n, fill),
      expected = structuredClone(d)
    expected.nodes[n.id] = { ...n, width: 65, height: 81, sizing: undefined }
    const actual = kernelLayout(d)
    expect(actual.nodes[n.id].height).toBe(81)
    expect(actual.nodes[inner.id].height).toBe(105)
    expect(actual.nodes[inner.id].width).toBe(fill ? 100 : 81)
    expect(actual.nodes[outer.id].height).toBe(125)
    expect(actual.nodes[sibling.id].transform[5]).toBe(90)
    expect(kernelLayout(actual)).toEqual(actual)
    for (const zoom of [0.25, 1, 1.375, 4, 1]) {
      const wanted = render(expected, zoom)
      expect(wanted.some((byte, i) => i % 4 === 3 && byte > 0)).toBe(true)
      expect(render(d, zoom).every((byte, i) => byte === wanted[i])).toBe(true)
      // Text selection is its resolved box, not glyph ink.
      expect(
        kernelHitWorld(actual.nodes[n.id], { x: 30, y: 80.875 }, [1, 0, 0, 1, 0, 0], zoom, 0),
      ).toBe(true)
      expect(
        kernelHitWorld(actual.nodes[n.id], { x: 30, y: 81.125 }, [1, 0, 0, 1, 0, 0], zoom, 0),
      ).toBe(false)
    }
  }
})

test('alignment and direction flags preserve fixed-width geometry without claiming RTL-script parity', () => {
  for (const align of ['start', 'center', 'end', 'justify'] as const)
    for (const direction of ['ltr', 'rtl'] as const)
      for (const indent of [-12.375, 0, 25]) {
        const n = text()
        n.text = '中文 AB 中文 AB'
        n.textStyle = {
          ...defaultTextStyle(),
          ...n.textStyle,
          align,
          direction,
          paragraphIndent: indent,
        }
        const expected = kernelTextLayout({ ...n, width: 65, sizing: undefined })
        const solved = kernelLayout(document(n)).nodes[n.id]
        expect(solved.height).toBeCloseTo(expected.height, 10)
        expect(kernelTextLayout(solved)).toEqual(expected)
      }
  const n = text()
  n.text = '中'
  n.fontSize = 80
  const solved = kernelLayout(document(n)).nodes[n.id]
  expect([solved.width, solved.height]).toEqual([65, 108])
  expect(kernelTextLayout(solved).width).toBeGreaterThan(solved.width)
})

test('each resolve observes later text, font size, rich runs and width-limit edits', () => {
  const n = text()
  let d = document(n)
  for (let step = 0; step < 6; step++) {
    const t = d.nodes[n.id]
    if (step === 1) t.text = '中文'
    if (step === 2) t.fontSize = 28
    if (step === 3) t.textRuns = [{ start: 0, end: 2, fontSize: 40, weight: 800 }]
    if (step === 4) t.sizing = { ...defaultSizing(), ...t.sizing, maxWidth: 120 }
    if (step === 5) t.sizing = { ...defaultSizing(), ...t.sizing, maxWidth: 30 }
    d = kernelLayout(d)
    expect(d.nodes[n.id].height).toBeCloseTo([81, 27, 75.6, 108, 54, 108][step], 10)
    expect(kernelTextLayout(d.nodes[n.id]).height).toBeCloseTo(d.nodes[n.id].height, 10)
  }
  d.nodes[n.id].textStyle = { ...defaultTextStyle(), ...d.nodes[n.id].textStyle, fontId: 'missing' }
  expect(() => kernelLayout(d)).toThrow(/Missing font/)
})

test('component variants and variable modes update constrained text before fresh layout', () => {
  const long = text(),
    short = text(),
    a = node('frame'),
    b = node('frame'),
    set = node('section'),
    instance = node('frame')
  long.componentKey = 'label'
  short.componentKey = 'label'
  short.text = '中文'
  for (const [root, child, state] of [
    [a, long, 'long'],
    [b, short, 'short'],
  ] as const) {
    root.children = [child.id]
    root.component = { variants: { State: state }, properties: {} }
    root.layout = { ...defaultLayout(), mode: 'vertical', padding: [0, 0, 0, 0] }
    root.sizing = { ...defaultSizing(), width: 'hug', height: 'hug' }
  }
  set.componentSet = true
  set.children = [a.id, b.id]
  instance.instance = { componentId: a.id, overrides: {}, propertyValues: {} }
  let d = document(set)
  for (const n of [long, short, a, b, instance]) d.nodes[n.id] = n
  d.pages[0].children.push(instance.id)
  let generatedId: string | undefined
  for (const [componentId, height] of [
    [a.id, 81],
    [b.id, 27],
    [a.id, 81],
  ] as const) {
    d.nodes[instance.id].instance = { componentId, overrides: {}, propertyValues: {} }
    d = kernelLayout(d)
    const generated = Object.values(d.nodes).find(
      (n) => n.instanceOrigin?.owner === instance.id && n.instanceOrigin?.key === 'label',
    )
    expect(generated?.height).toBe(height)
    expect(d.nodes[instance.id].height).toBe(height)
    if (generatedId) expect(generated?.id).toBe(generatedId)
    generatedId = generated?.id
  }
  const n = text()
  d = document(n)
  d.designSystem = {
    collections: { c: { name: 'Size', modes: ['small', 'large'], defaultMode: 'small' } },
    variables: {
      size: { name: 'Size', collection: 'c', kind: 'number', values: { small: 20, large: 28 } },
    },
    activeModes: { c: 'small' },
    styles: {},
    libraries: {},
  }
  d.nodes[n.id].bindings = { fontSize: 'size' }
  for (const [mode, height] of [
    ['small', 81],
    ['large', 151.2],
    ['small', 81],
  ] as const) {
    d.designSystem = {
      ...d.designSystem,
      activeModes: { c: mode },
    } as DesignDocument['designSystem']
    d = kernelLayout(d)
    expect(d.nodes[n.id].height).toBeCloseTo(height, 10)
  }
})
