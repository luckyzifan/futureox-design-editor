import { expect, test } from 'vitest'
import { blank, defaultTextStyle, node } from './model'
import { emptySystem } from './design-system'
import { matchBundledImportFonts, retainedFontWarnings } from './bundled-import-fonts'

test('Inter, ABeeZee, and Poppins import names attach the bundled files', async () => {
  const doc = blank('字体')
  const text = node('text', 0, 0, 120, 32)
  text.text = 'Ag'
  text.textStyle = defaultTextStyle()
  doc.nodes = { [text.id]: text }
  const fontSources: NonNullable<ReturnType<typeof emptySystem>['fontSources']> = { [text.id]: { style: 'Inter Regular' } }
  doc.designSystem = { ...emptySystem(), fontSources }
  const abeezee = node('text', 0, 20, 80, 24)
  abeezee.text = 'Bee'
  abeezee.textStyle = defaultTextStyle()
  doc.nodes[abeezee.id] = abeezee
  const poppins = node('text', 0, 40, 80, 24)
  poppins.text = 'Hi'
  poppins.textStyle = defaultTextStyle()
  doc.nodes[poppins.id] = poppins
  fontSources[abeezee.id] = { style: 'ABeeZee Regular' }
  fontSources[poppins.id] = { style: 'Poppins' }
  const matched = await matchBundledImportFonts(doc)
  expect(matched.families).toEqual(expect.arrayContaining(['Inter', 'ABeeZee', 'Poppins']))
  expect(text.textStyle.fontId).toMatch(/^[0-9a-f]{64}-0$/)
  expect(poppins.textStyle.fontId).toMatch(/^[0-9a-f]{64}-0$/)
  expect(matched.missing).not.toContain('Inter Regular')
  expect(abeezee.textStyle.fontId).toMatch(/^[0-9a-f]{64}-0$/)
  expect(doc.fonts?.[abeezee.textStyle.fontId!].family).toContain('ABeeZee')
  expect(matched.missing).not.toContain('ABeeZee Regular')
  expect(doc.fonts?.[text.textStyle.fontId!].family).toContain('Inter')
  const italic = node('text', 0, 60, 80, 24)
  italic.text = 'It'
  italic.textStyle = defaultTextStyle()
  doc.nodes[italic.id] = italic
  fontSources[italic.id] = { style: 'Poppins BoldItalic' }
  const again = await matchBundledImportFonts(doc)
  expect(again.missing).not.toContain('Poppins BoldItalic')
  expect(again.substitutions.some(item => item.from === 'Poppins BoldItalic')).toBe(false)
  expect(doc.fonts?.[italic.textStyle.fontId!].postscript).toBe('Poppins-BoldItalic')
})

test('a matched family warning is case-insensitive, and a missing face keeps it', () => {
  const warning = '字体 poppins 尚需匹配，已保留文字内容'
  expect(retainedFontWarnings([warning, '其他'], { families: ['Poppins'], missing: [], substitutions: [] })).toEqual(['其他'])
  expect(retainedFontWarnings([warning], { families: ['Poppins'], missing: ['Poppins Light'], substitutions: [] })).toEqual([warning])
  expect(retainedFontWarnings(['字体 ABeeZee 尚需匹配，已保留文字内容'], {
    families: [], missing: [], substitutions: [{ from: 'ABeeZee-Regular' }],
  })).toEqual([])
})
