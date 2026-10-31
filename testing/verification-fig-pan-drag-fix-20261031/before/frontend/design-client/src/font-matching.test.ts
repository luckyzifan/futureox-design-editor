import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { blank, node, defaultTextStyle } from './model'
import { emptySystem } from './design-system'
import { matchFont, applyMatchedFonts, unmatchedSourceFonts } from './font-matching'
import { browserFontResource } from './SystemFontPicker'
import { font_faces_json, VectorEngine } from './generated/design-kernel/design_kernel'

test('exact original font matching preserves mixed runs and authored replacements', () => {
  const doc = blank(), text = node('text', 0, 0, 100, 30)
  text.text = 'ab'; text.textStyle = defaultTextStyle()
  text.textRuns = [{ start: 0, end: 1, fontId: 'default', color: '#ff0000', fontSize: 17 },
    { start: 1, end: 2, fontId: 'already-chosen', weight: 700 }]
  doc.nodes = { [text.id]: text }; doc.designSystem = { ...emptySystem(),
    fontSources: { [text.id]: { style: 'Source-Regular', runs: { 0: 'Source-Bold', 1: 'Source-Bold' } } } }
  const regular = { id: 'regular', resource: { family: 'Source', data: '', index: 0 } }
  const bold = { id: 'bold', resource: { family: 'Source Bold', data: '', index: 1 } }
  expect(unmatchedSourceFonts(doc, text)).toEqual(['Source-Regular', 'Source-Bold'])
  expect(applyMatchedFonts(doc, new Map([['Source-Regular', regular], ['Source-Bold', bold]]))).toBe(2)
  expect(text.textStyle.fontId).toBe('regular')
  expect(text.textRuns[0]).toEqual({ start: 0, end: 1, fontId: 'bold', color: '#ff0000', fontSize: 17 })
  expect(text.textRuns[1].fontId).toBe('already-chosen')
  expect(unmatchedSourceFonts(doc, text)).toEqual([])
})
test('ambiguous font identities and wrong styles are never silently selected', () => {
  const regular = { family: 'Source', style: 'Regular', postscript: 'Source-Regular' }
  const bold = { family: 'Source', style: 'Bold', postscript: 'Source-Bold' }
  expect(matchFont('Source Bold', [regular, bold])).toBe(bold)
  expect(matchFont('Source', [regular, bold])).toBe(regular)
  expect(matchFont('Source-Regular', [regular, { ...regular }])).toBeUndefined()
  expect(matchFont('Source-Italic', [regular, bold])).toBeUndefined()
})
test('browser font bytes retain their verified identity and render in the actual kernel', async () => {
  const bytes = readFileSync(new URL('../public/fonts/NotoSansSC.ttf', import.meta.url))
  const [face] = JSON.parse(font_faces_json(bytes))
  const font = { ...face, postscriptName: face.postscript, blob: async () => new Blob([bytes]) }
  const resource = await browserFontResource(font)
  expect(resource.index).toBe(face.index)
  const engine = new VectorEngine()
  try {
    engine.load_document_fonts(JSON.stringify({ selected: resource }))
    const text = node('text', 0, 0, 200, 50)
    text.text = '字体117'; text.textStyle = { ...defaultTextStyle(), fontId: 'selected' }
    const layout = JSON.parse(engine.text_layout(JSON.stringify(text)))
    expect(layout.glyphs.every((g: { fontId: string; id: number }) => g.fontId === 'selected' && g.id > 0)).toBe(true)
  } finally { engine.free() }
  await expect(browserFontResource({ ...font, postscriptName: 'wrong-face' })).rejects.toThrow('唯一匹配')
})
