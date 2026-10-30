import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { VectorEngine } from './generated/design-kernel/design_kernel'
import { blank, defaultTextStyle, node, paint } from './model'
import { Editor } from './engine'
import { applyWholeTextStyle, clearWholeTextRunColor, setWholeTextFontSize } from './text'

type Layout = { width: number; bounds: { width: number; height: number }; glyphs: { fontId: string; size: number; weight: number }[] }

function importedText() {
  const text = node('text', 0, 0, 600, 100)
  text.text = '标题 87,859'
  text.fontSize = 40
  text.textStyle = { ...defaultTextStyle(), wrap: false }
  text.textRuns = [{ start: 0, end: text.text.length, fontId: 'default', fontSize: 40, weight: 400, color: '#ffffff', underline: true }]
  return text
}

test('whole-layer formatting reaches real kernel glyphs instead of only moving their baseline', () => {
  const bytes = readFileSync(new URL('../public/fonts/NotoSansSC.ttf', import.meta.url))
  const engine = new VectorEngine()
  try {
    engine.load_font(bytes)
    engine.load_document_fonts(JSON.stringify({ replacement: { family: 'Named Noto test face', data: bytes.toString('base64') } }))
    const text = importedText()
    const layout = (value: typeof text) => JSON.parse(engine.text_layout(JSON.stringify(value))) as Layout
    const before = layout(text)
    const ineffective = structuredClone(text)
    ineffective.textStyle!.fontId = 'replacement'
    ineffective.fontSize = 80
    const overridden = layout(ineffective)
    expect(overridden.glyphs.every(glyph => glyph.fontId === 'default' && glyph.size === 40)).toBe(true)
    expect(overridden.bounds.height).toBeCloseTo(before.bounds.height, 8)

    applyWholeTextStyle(text, { fontId: 'replacement' })
    setWholeTextFontSize(text, 80)
    const after = layout(text)
    expect(after.glyphs.length).toBeGreaterThan(0)
    expect(after.glyphs.every(glyph => glyph.fontId === 'replacement' && glyph.size === 80 && glyph.weight === 400)).toBe(true)
    expect(after.width).toBeCloseTo(before.width * 2, 8)
    expect(after.bounds.width).toBeCloseTo(before.bounds.width * 2, 8)
    expect(after.bounds.height).toBeCloseTo(before.bounds.height * 2, 8)
    expect(text.textRuns).toEqual([{ start: 0, end: text.text.length, weight: 400, color: '#ffffff', underline: true }])

    applyWholeTextStyle(text, { weight: 700 })
    expect(layout(text).glyphs.every(glyph => glyph.weight === 700)).toBe(true)
  } finally { engine.free() }
})

test('whole-layer font-size history restores the original imported run overrides on undo', () => {
  const doc = blank('Imported text formatting')
  const text = importedText()
  doc.nodes[text.id] = text
  doc.pages[0].children = [text.id]
  const editor = new Editor(doc)
  try {
    const before = structuredClone(editor.state.doc.nodes[text.id])
    editor.change('修改整层字号', draft => setWholeTextFontSize(draft.nodes[text.id], 80))
    expect(editor.state.doc.nodes[text.id].fontSize).toBe(80)
    expect(editor.state.doc.nodes[text.id].textRuns?.[0].fontSize).toBeUndefined()
    editor.undo()
    expect(editor.state.doc.nodes[text.id]).toEqual(before)
    editor.redo()
    expect(editor.state.doc.nodes[text.id].fontSize).toBe(80)
    expect(editor.state.doc.nodes[text.id].textRuns?.[0]).toMatchObject({ color: '#ffffff', underline: true, fontId: 'default', weight: 400 })
  } finally { editor.dispose() }
})

test('a layer fill edit changes real CPU text pixels that imported run colors otherwise override', () => {
  const engine = new VectorEngine()
  try {
    engine.load_font(readFileSync(new URL('../public/fonts/NotoSansSC.ttf', import.meta.url)))
    const doc = blank('Text fill inheritance'), text = importedText()
    doc.schemaVersion = 4
    text.text = 'Hi'; text.fontSize = 24; text.width = 120; text.height = 48
    text.fills = [paint('#ffffff')]
    text.textRuns = [{ start: 0, end: 2, fontId: 'default', fontSize: 24, color: '#ffffff' }]
    doc.nodes[text.id] = text; doc.pages[0].children = [text.id]
    const raster = () => {
      engine.load_document(JSON.stringify(doc))
      return new Uint8Array(engine.render_rgba(JSON.stringify({ pageId: doc.pages[0].id, width: 128, height: 64,
        view: { x: 4, y: 0, zoom: 1 }, transparent: true, rasterProfile: 'analytic' })))
    }
    const before = raster()
    text.fills[0] = paint('#ff3366')
    expect(raster()).toEqual(before)
    clearWholeTextRunColor(text)
    const after = raster()
    expect(after).not.toEqual(before)
    let pink = 0
    for (let i = 0; i < after.length; i += 4)
      if (after[i] === 255 && after[i + 1] === 51 && after[i + 2] === 102 && after[i + 3] > 200) pink++
    expect(pink).toBeGreaterThan(30)
  } finally { engine.free() }
})
