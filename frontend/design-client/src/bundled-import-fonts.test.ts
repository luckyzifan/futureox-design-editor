import { expect, test } from 'vitest'
import { blank, defaultTextStyle, node } from './model'
import { emptySystem } from './design-system'
import { abeezeeLineBreakDiagnostic, fontDigestDiagnostic, matchBundledImportFonts, retainedFontWarnings, selectBundledImportFace } from './bundled-import-fonts'
import { applyMatchedFonts } from './font-matching'

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

test('a FIG digest selects that file and a different cut stays unmatched', async () => {
  const v2 = '45dc28c425c3ee2237440bf9cb926753c5aa3b5c'
  const v4 = '45e4d582cbb4dab2bbad3f624fad9ae567c66547'
  expect(selectBundledImportFace('Poppins Bold', v2)?.sha.startsWith('b8b92424')).toBe(true)
  expect(selectBundledImportFace('Poppins Bold', v4)?.postscript).toBe('Poppins-Bold')
  expect(selectBundledImportFace('Poppins Bold')?.sha1).toBe(v4)
  expect(selectBundledImportFace('Inter Regular', 'd483e2c7f8032c6638d047167efbeba0030f0649')).toBeUndefined()
  const doc = blank('摘要')
  const text = node('text', 0, 0, 120, 32)
  text.text = 'Back to Home'
  text.textStyle = defaultTextStyle()
  doc.nodes = { [text.id]: text }
  doc.designSystem = { ...emptySystem(), fontSources: { [text.id]: { style: 'Poppins Bold', digest: v2 } } }
  const matched = await matchBundledImportFonts(doc)
  expect(matched.digestMismatches).toEqual([])
  expect(matched.substitutions).toEqual([])
  expect(text.textStyle.fontId).toBe('b8b92424acfd9581c9dd74723a5627b6a5882a643b2148bd0463e9cd077d3728-0')
  const unknown = blank('无摘要文件')
  const inter = node('text', 0, 0, 80, 24)
  inter.text = 'ABC'
  inter.textStyle = defaultTextStyle()
  unknown.nodes = { [inter.id]: inter }
  unknown.designSystem = { ...emptySystem(), fontSources: { [inter.id]: { style: 'Inter Regular', digest: 'd483e2c7f8032c6638d047167efbeba0030f0649' } } }
  const missed = await matchBundledImportFonts(unknown)
  expect(missed.digestMismatches).toEqual([{ name: 'Inter Regular', digest: 'd483e2c7f8032c6638d047167efbeba0030f0649' }])
  expect(inter.textStyle?.fontId ?? 'default').toBe('default')
  expect(Object.values(unknown.fonts || {}).some(face => face.postscript === 'Inter-Regular')).toBe(false)
  expect(fontDigestDiagnostic('Inter Regular', 'd483e2c7f8032c6638d047167efbeba0030f0649')).toContain('不能把同名的另一个文件')
  const blocked = blank('同名')
  const bold = node('text', 0, 0, 80, 24)
  bold.text = 'B'
  bold.textStyle = defaultTextStyle()
  blocked.nodes = { [bold.id]: bold }
  blocked.designSystem = { ...emptySystem(), fontSources: { [bold.id]: { style: 'Poppins Bold', digest: v2 } } }
  applyMatchedFonts(blocked, new Map([['Poppins Bold', { id: 'name-only', resource: { family: 'Poppins Bold', data: 'QQ==', index: 0 } }]]))
  expect(bold.textStyle?.fontId ?? 'default').toBe('default')
})

test('ABeeZee italic stays unmatched instead of borrowing Regular line breaks', async () => {
  expect(selectBundledImportFace('ABeeZee')?.postscript).toBe('ABeeZee-Regular')
  expect(selectBundledImportFace('ABeeZee Regular')?.style).toBe('Regular')
  expect(selectBundledImportFace('ABeeZee Italic')).toBeUndefined()
  expect(selectBundledImportFace('ABeeZee-Italic')).toBeUndefined()
  expect(abeezeeLineBreakDiagnostic('ABeeZee Italic')).toContain('不能把 Regular 的换行')
  expect(abeezeeLineBreakDiagnostic('ABeeZee')).toBeUndefined()
  const doc = blank('斜体')
  const text = node('text', 0, 0, 200, 80)
  text.text = 'Poster title'
  text.textStyle = defaultTextStyle()
  doc.nodes = { [text.id]: text }
  doc.designSystem = { ...emptySystem(), fontSources: { [text.id]: { style: 'ABeeZee Italic' } } }
  const matched = await matchBundledImportFonts(doc)
  expect(matched.substitutions).toEqual([])
  expect(matched.missing).toContain('ABeeZee Italic')
  expect(doc.nodes[text.id].textStyle?.fontId ?? 'default').toBe('default')
})

test('a matched family warning is case-insensitive, and a missing face keeps it', () => {
  const warning = '字体 poppins 尚需匹配，已保留文字内容'
  expect(retainedFontWarnings([warning, '其他'], { families: ['Poppins'], missing: [], substitutions: [] })).toEqual(['其他'])
  expect(retainedFontWarnings([warning], { families: ['Poppins'], missing: ['Poppins Light'], substitutions: [] })).toEqual([warning])
  expect(retainedFontWarnings(['字体 ABeeZee 尚需匹配，已保留文字内容'], {
    families: [], missing: [], substitutions: [{ from: 'ABeeZee-Regular' }],
  })).toEqual([])
})
