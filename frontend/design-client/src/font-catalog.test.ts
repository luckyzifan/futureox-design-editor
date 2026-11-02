import { expect, test } from 'vitest'
import { blank, defaultTextStyle, node } from './model'
import { emptySystem } from './design-system'
import { unmatchedSourceFonts } from './font-matching'
import { catalogEntryFor, matchFontStyle, parseFontStyle, resolveListedFace, suggestFontFace } from './font-catalog'
import { applyFontSubstitutions, suggestDocumentFont } from './font-substitution'
import { svgFontFaceCss, cssFontStyle } from './svg-font-face'

const face = (family: string, style: string, extra: Record<string, unknown> = {}) => ({ family, style, postscript: `${family.replace(/ /g, '')}-${style.replace(/ /g, '')}`, ...extra })

test('style tokens recognize weight and italic without treating unknown words as bold', () => {
  expect(parseFontStyle('SemiBold Italic')).toMatchObject({ weight: 600, italic: true, stretch: 'normal' })
  expect(parseFontStyle('Condensed Bold')).toMatchObject({ weight: 700, stretch: 'condensed', italic: false })
  expect(parseFontStyle('Black')).toMatchObject({ weight: 900, italic: false })
  expect(parseFontStyle('700')).toMatchObject({ weight: 700 })
  expect(parseFontStyle('Missing Bold').weight).toBeUndefined()
  expect(catalogEntryFor('Noto Sans SC Bold')?.entry.family).toBe('Noto Sans SC')
  expect(catalogEntryFor('Internal Sans')).toBeUndefined()
})

test('aliases and variable axes match a face, and a different weight stays a suggestion', () => {
  const yahei = [face('Microsoft YaHei', 'Regular', { weight: 400 }), face('Microsoft YaHei', 'Bold', { weight: 700 })]
  expect(resolveListedFace('微软雅黑 Bold', yahei)?.style).toBe('Bold')
  expect(resolveListedFace('微软雅黑', yahei)?.style).toBe('Regular')
  expect(resolveListedFace('PingFang SC', yahei)).toBeUndefined()
  const inter = [
    face('Inter', 'Regular', { weight: 400 }),
    face('Inter', 'Bold', { weight: 700 }),
    face('Inter', 'Italic', { weight: 400, italic: true }),
  ]
  expect(resolveListedFace('Inter Black', inter)).toBeUndefined()
  expect(matchFontStyle('Inter Black', inter)?.face.style).toBe('Bold')
  expect(resolveListedFace('Inter 700', inter)?.style).toBe('Bold')
  expect(resolveListedFace('Inter Italic', inter)?.style).toBe('Italic')
  expect(matchFontStyle('Inter', [inter[1]!, inter[2]!])?.face.style).toBe('Bold')
  expect(resolveListedFace('Inter', [inter[1]!, inter[2]!])).toBeUndefined()
  const variable = face('Inter', 'Regular', { weight: 400, variable: true, axes: [{ tag: 'wght', min: 100, max: 900, default: 400 }] })
  expect(resolveListedFace('Inter Medium', [variable])?.family).toBe('Inter')
  expect(resolveListedFace('Inter Medium', [variable, inter[1]!])?.style).toBe('Regular')
  expect(matchFontStyle('Inter', [face('Inter', 'Light', { weight: 300 }), face('Inter', 'Medium', { weight: 500 })])).toBeUndefined()
})

test('CJK and web names suggest the built-in face until a real family is present', () => {
  const none: [] = []
  const ping = suggestDocumentFont('PingFang TC', none)
  expect(ping.fontId).toBe('default')
  expect(ping.kind === 'substitute' || ping.kind === 'builtin').toBe(true)
  expect(suggestDocumentFont('思源黑体', none).fontId).toBe('default')
  expect(suggestFontFace('思源黑体', [{ id: 'default', family: 'Noto Sans SC', style: 'Regular', postscript: '' }]).kind).toMatch(/alias|exact|substitute/)
  expect(suggestDocumentFont('Inter', none).kind).toBe('builtin')
  const embedded = suggestDocumentFont('Arial', [face('Arimo', 'Regular', { id: 'arimo', weight: 400 }) as ReturnType<typeof face> & { id: string }])
  expect(embedded.fontId).toBe('arimo')
  expect(embedded.kind).toBe('substitute')
})

test('confirming a built-in substitute clears the missing warning and keeps the other run', () => {
  const doc = blank('缺失字体')
  doc.schemaVersion = 4
  const text = node('text', 0, 0, 200, 40)
  text.text = '甲乙'
  text.textStyle = { ...defaultTextStyle(), weight: 700 }
  text.textRuns = [{ start: 0, end: 1, weight: 300 }]
  doc.nodes[text.id] = text
  doc.pages[0].children = [text.id]
  doc.designSystem = { ...emptySystem(), fontSources: { [text.id]: { style: 'PingFang SC', runs: { 0: 'PingFang SC Light' } } } }
  const locked = node('text', 0, 40, 80, 20)
  locked.text = '锁'
  locked.locked = true
  locked.textStyle = defaultTextStyle()
  doc.nodes[locked.id] = locked
  doc.pages[0].children.push(locked.id)
  doc.designSystem.fontSources[locked.id] = { style: 'Microsoft YaHei' }
  expect(unmatchedSourceFonts(doc, text)).toEqual(['PingFang SC', 'PingFang SC Light'])
  const applied = applyFontSubstitutions(doc, [
    { name: 'PingFang SC', fontId: 'default' },
    { name: 'PingFang SC Light', fontId: 'default' },
  ])
  expect(applied.changedNodes).toBe(1)
  expect(text.textStyle?.fontId).toBe('default')
  expect(text.textStyle?.weight).toBe(700)
  expect(text.textRuns?.[0].fontId).toBe('default')
  expect(text.textRuns?.[0].weight).toBe(300)
  expect(unmatchedSourceFonts(doc, text)).toEqual([])
  expect(doc.designSystem?.fontSources?.[text.id].style).toBe('PingFang SC')
  expect(doc.designSystem?.fontSources?.[text.id].resolved).toEqual(['PingFang SC Light', 'PingFang SC'])
  expect(unmatchedSourceFonts(doc, locked)).toEqual(['Microsoft YaHei'])
})

test('a style-only instance override does not retarget an inherited source run', () => {
  const doc = blank('继承')
  doc.schemaVersion = 4
  const owner = node('frame', 0, 0, 20, 20)
  owner.instance = { componentId: 'component', overrides: { label: { textStyle: defaultTextStyle() } }, propertyValues: {} }
  const text = node('text', 0, 0, 40, 20)
  text.text = '甲'
  text.textStyle = defaultTextStyle()
  text.textRuns = [{ start: 0, end: 1 }]
  text.instanceOrigin = { owner: owner.id, key: 'label', source: 'component' }
  doc.nodes = { [owner.id]: owner, [text.id]: text }
  doc.pages[0].children = [owner.id]
  doc.designSystem = { ...emptySystem(), fontSources: { [text.id]: { style: 'PingFang SC', runs: { 0: 'PingFang SC Light' } } } }
  const applied = applyFontSubstitutions(doc, [{ name: 'PingFang SC', fontId: 'default' }, { name: 'PingFang SC Light', fontId: 'default' }])
  expect(applied.deferredInherited).toBe(1)
  expect(applied.changedNodes).toBe(0)
  expect(text.textStyle?.fontId).toBe('default')
  expect(text.textRuns?.[0].fontId).toBeUndefined()
  expect(unmatchedSourceFonts(doc, text)).toEqual(['PingFang SC', 'PingFang SC Light'])
})

test('a missing font id is rejected and a locked layer is not rewritten', () => {
  const doc = blank('拒绝')
  doc.schemaVersion = 4
  const text = node('text', 0, 0, 40, 20)
  text.text = '甲'
  text.textStyle = defaultTextStyle()
  doc.nodes[text.id] = text
  doc.pages[0].children = [text.id]
  doc.designSystem = { ...emptySystem(), fontSources: { [text.id]: { style: 'Inter' } } }
  expect(() => applyFontSubstitutions(doc, [{ name: 'Inter', fontId: 'not-installed' }])).toThrow(/字体资源不存在/)
  expect(text.textStyle?.fontId).toBe('default')
  expect(unmatchedSourceFonts(doc, text)).toEqual(['Inter'])
})

test('editable SVG face rules name weight and italic and still accept the previous rule', () => {
  expect(cssFontStyle('Source Italic')).toBe('italic')
  expect(cssFontStyle('Source Sans')).toBe('normal')
  const variable = svgFontFaceCss('Noto Sans SC', 'AAAA', 'font/ttf', 'truetype', { variable: true, axes: [{ tag: 'wght', min: 100, max: 900 }] })
  expect(variable).toContain('font-style:normal;')
  expect(variable).toContain('font-weight:100 900;')
  expect(variable).toContain('data:font/ttf;base64,AAAA')
  const legacy = svgFontFaceCss('Poppins Bold', 'AAAA', 'font/ttf', 'truetype', undefined, true)
  expect(legacy).toBe('@font-face{font-family:"\\50 \\6f \\70 \\70 \\69 \\6e \\73 \\20 \\42 \\6f \\6c \\64 ";src:url("data:font/ttf;base64,AAAA") format("truetype");}')
  expect(svgFontFaceCss('Source Italic', 'AAAA', 'font/otf', 'opentype', { weight: 400, italic: true })).toContain('font-style:italic;font-weight:400;')
})
