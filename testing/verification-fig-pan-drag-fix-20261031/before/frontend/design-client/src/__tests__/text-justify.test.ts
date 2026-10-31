import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { VectorEngine } from '../generated/design-kernel/design_kernel'
import { blank, defaultTextStyle, node, validateDocument } from '../model'

// Real production admission and native-WASM shaping. No copied layout algorithm.
test('justify is admitted as a text style and invalid alignment is rejected', () => {
  const doc = blank(), text = node('text', 0, 0, 130, 200)
  doc.schemaVersion = 4
  text.text = 'one two three four five six seven eight'
  text.textStyle = { ...defaultTextStyle(), align: 'justify' }
  doc.nodes[text.id] = text; doc.pages[0].children.push(text.id)
  expect(validateDocument(doc).nodes[text.id].textStyle?.align).toBe('justify')
  const invalid = structuredClone(doc) as any
  invalid.nodes[text.id].textStyle.align = 'not-an-alignment'
  expect(() => validateDocument(invalid)).toThrow(/文字样式/)
})

test('real WASM justify expands wrapped lines and leaves the final paragraph line unchanged', () => {
  const engine = new VectorEngine()
  try {
    engine.load_font(readFileSync(new URL('../../public/fonts/NotoSansSC.ttf', import.meta.url)))
    const text = node('text', 0, 0, 130, 200)
    text.text = 'one two three four five six seven eight nine ten'
    text.fontSize = 16
    text.textStyle = { ...defaultTextStyle(), wrap: true, align: 'start' }
    const start = JSON.parse(engine.text_layout(JSON.stringify(text)))
    text.textStyle.align = 'justify'
    const justified = JSON.parse(engine.text_layout(JSON.stringify(text)))
    expect(start.lines.length).toBeGreaterThan(1)
    expect(start.glyphs.length).toBeGreaterThan(10)
    expect(justified.lines).toEqual(start.lines)
    const lineGlyphs = (layout: any, line: any) => layout.glyphs.filter((g: any) => g.cluster >= line.start && g.cluster < line.end)
    const first = start.lines[0], last = start.lines.at(-1)
    const before = lineGlyphs(start, first), after = lineGlyphs(justified, first)
    expect(after.length).toBe(before.length)
    expect(after.at(-1).x).toBeGreaterThan(before.at(-1).x)
    expect(after.some((g: any, i: number) => g.advance > before[i].advance)).toBe(true)
    expect(lineGlyphs(justified, last)).toEqual(lineGlyphs(start, last))
    text.textStyle.align = 'start'
    expect(JSON.parse(engine.text_layout(JSON.stringify(text)))).toEqual(start)
  } finally { engine.free() }
})
