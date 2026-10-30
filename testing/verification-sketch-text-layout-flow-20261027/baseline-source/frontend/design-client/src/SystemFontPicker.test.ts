import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { nativeFontResource } from './SystemFontPicker'
import { VectorEngine } from './generated/design-kernel/design_kernel'
import { defaultTextStyle, node } from './model'
import type { DesktopFontData } from './desktop'

function extractedFace(): DesktopFontData {
  return { font: { id: 'opaque-native-handle', family: 'Returned family', style: 'Bold',
    postscript: 'ReturnedFamily-Bold', index: 4, sourceIndex: 4 },
    data: readFileSync(new URL('../public/fonts/NotoSansSC.ttf', import.meta.url)).toString('base64'),
    index: 0, sourceIndex: 4, extracted: true }
}

test('an extracted font face installs and shapes through the real kernel at its returned index', () => {
  const read = extractedFace(), resource = nativeFontResource(read)
  expect(resource.index).toBe(0)
  expect(resource.postscript).toBe(read.font.postscript)
  expect(resource.family).toBe('Returned family Bold')
  const engine = new VectorEngine()
  try {
    engine.load_document_fonts(JSON.stringify({ selected: resource }))
    const text = node('text', 0, 0, 240, 50)
    text.text = '117'; text.fontSize = 24
    text.textStyle = { ...defaultTextStyle(), fontId: 'selected' }
    const layout = JSON.parse(engine.text_layout(JSON.stringify(text)))
    expect(layout.glyphs).toHaveLength(3)
    expect(layout.glyphs.every((glyph: { fontId: string; id: number }) => glyph.fontId === 'selected' && glyph.id > 0)).toBe(true)
    expect(layout.bounds.width).toBeGreaterThan(10)
    expect(layout.spans[0].path.length).toBeGreaterThan(0)
  } finally { engine.free() }
})

test('an extracted response cannot reuse the source collection index', () => {
  const read = extractedFace()
  read.index = read.sourceIndex
  expect(() => nativeFontResource(read)).toThrow('无效的字形索引')
})
