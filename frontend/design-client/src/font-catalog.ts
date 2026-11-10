import { matchFont, type FontIdentity } from './font-matching'

export type FontScript = 'latin' | 'sc' | 'tc' | 'jp' | 'kr'
export type CatalogFamily = {
  family: string
  aliases: readonly string[]
  scripts: readonly FontScript[]
  category: 'bundled' | 'web' | 'cjk' | 'system'
  /** Other catalog families to try after this one is absent. Not an automatic install. */
  substitutes: readonly string[]
}

/** The built-in file is the variable Noto Sans SC face. Axis numbers match
 * that file's fvar table; the shaper already drives `wght` from text weight. */
export const BUNDLED_NOTO_SANS_SC = Object.freeze({
  family: 'Noto Sans SC',
  weight: 400,
  italic: false,
  variable: true,
  axes: Object.freeze([Object.freeze({ tag: 'wght', min: 100, max: 900, default: 400 })]),
})

const cjk = (family: string, scripts: readonly FontScript[], aliases: readonly string[] = [], substitutes: readonly string[] = ['Noto Sans SC']): CatalogFamily =>
  ({ family, aliases, scripts, category: 'cjk', substitutes })
const web = (family: string, aliases: readonly string[] = []): CatalogFamily =>
  ({ family, aliases, scripts: ['latin'], category: 'web', substitutes: [] })
const system = (family: string, aliases: readonly string[] = [], substitutes: readonly string[] = []): CatalogFamily =>
  ({ family, aliases, scripts: ['latin'], category: 'system', substitutes })

export const FONT_CATALOG: readonly CatalogFamily[] = Object.freeze([
  { family: 'Noto Sans SC', aliases: ['Noto Sans CJK SC', 'Source Han Sans SC', '思源黑体', '思源黑体 SC', 'NotoSansSC'], scripts: ['sc', 'latin'], category: 'bundled', substitutes: [] },
  { family: 'Poppins', aliases: ['Poppins-Regular'], scripts: ['latin'], category: 'bundled', substitutes: [] },
  { family: 'ABeeZee', aliases: ['ABeeZee-Regular'], scripts: ['latin'], category: 'bundled', substitutes: [] },
  cjk('Noto Sans TC', ['tc', 'latin'], ['Noto Sans CJK TC', 'Source Han Sans TC', 'Source Han Sans HC', '思源黑体 TC']),
  cjk('Noto Sans HK', ['tc', 'latin'], ['Noto Sans CJK HK', 'Source Han Sans HK']),
  cjk('Noto Sans JP', ['jp', 'latin'], ['Noto Sans CJK JP', 'Source Han Sans JP', '思源黑体 JP']),
  cjk('Noto Sans KR', ['kr', 'latin'], ['Noto Sans CJK KR', 'Source Han Sans KR', '본고딕']),
  cjk('Noto Serif SC', ['sc', 'latin'], ['Noto Serif CJK SC', 'Source Han Serif SC', '思源宋体']),
  cjk('Noto Serif TC', ['tc', 'latin'], ['Noto Serif CJK TC', 'Source Han Serif TC']),
  cjk('Noto Serif JP', ['jp', 'latin'], ['Noto Serif CJK JP', 'Source Han Serif JP']),
  cjk('Noto Serif KR', ['kr', 'latin'], ['Noto Serif CJK KR', 'Source Han Serif KR']),
  cjk('Source Han Sans', ['sc', 'latin'], ['思源黑体']),
  cjk('PingFang SC', ['sc', 'latin'], ['苹方-简', '苹方', 'PingFang-SC']),
  cjk('PingFang TC', ['tc', 'latin'], ['苹方-繁', 'PingFang-TC']),
  cjk('PingFang HK', ['tc', 'latin'], ['苹方-港']),
  cjk('Hiragino Sans', ['jp', 'latin'], ['Hiragino Kaku Gothic ProN', '冬青黑体', 'ヒラギノ角ゴシック']),
  cjk('Hiragino Sans GB', ['sc', 'latin'], ['冬青黑体简体中文', 'Hiragino Sans GB W3']),
  cjk('Hiragino Mincho', ['jp', 'latin'], ['Hiragino Mincho ProN', '冬青明朝']),
  cjk('Songti SC', ['sc', 'latin'], ['STSong', '宋体', 'SimSun', 'NSimSun', '新宋体']),
  cjk('STHeiti', ['sc', 'latin'], ['Heiti SC', '黑体', 'SimHei']),
  cjk('Heiti TC', ['tc', 'latin'], ['STHeiti TC']),
  cjk('STKaiti', ['sc', 'latin'], ['Kaiti SC', 'KaiTi', '楷体']),
  cjk('STFangsong', ['sc', 'latin'], ['FangSong', '仿宋']),
  cjk('Microsoft YaHei', ['sc', 'latin'], ['微软雅黑', 'Microsoft YaHei UI', 'MicrosoftYaHei']),
  cjk('Microsoft JhengHei', ['tc', 'latin'], ['微软正黑体', 'Microsoft JhengHei UI']),
  cjk('DengXian', ['sc', 'latin'], ['等线']),
  cjk('MingLiU', ['tc', 'latin'], ['PMingLiU', '细明体', '新细明体']),
  cjk('MS Gothic', ['jp', 'latin'], ['MS PGothic', 'ＭＳ ゴシック', 'ＭＳ Ｐゴシック']),
  cjk('MS Mincho', ['jp', 'latin'], ['MS PMincho', 'ＭＳ 明朝', 'ＭＳ Ｐ明朝']),
  cjk('Yu Gothic', ['jp', 'latin'], ['游ゴシック', 'YuGothic']),
  cjk('Yu Mincho', ['jp', 'latin'], ['游明朝', 'YuMincho']),
  cjk('Meiryo', ['jp', 'latin'], ['メイリオ']),
  cjk('Malgun Gothic', ['kr', 'latin'], ['맑은 고딕']),
  cjk('Apple SD Gothic Neo', ['kr', 'latin'], []),
  cjk('Gulim', ['kr', 'latin'], ['굴림']),
  cjk('Dotum', ['kr', 'latin'], ['돋움']),
  cjk('Batang', ['kr', 'latin'], ['바탕']),
  cjk('Gungsuh', ['kr', 'latin'], ['궁서']),
  cjk('WenQuanYi Micro Hei', ['sc', 'latin'], ['文泉驿微米黑']),
  cjk('WenQuanYi Zen Hei', ['sc', 'latin'], ['文泉驿正黑']),
  cjk('Droid Sans Fallback', ['sc', 'tc', 'jp', 'kr', 'latin'], ['DroidSansFallback']),
  { family: 'Inter', aliases: ['Inter-Regular', 'Inter Variable'], scripts: ['latin'], category: 'bundled', substitutes: [] },
  web('Roboto'),
  web('Open Sans'),
  web('Lato'),
  web('Montserrat'),
  web('Nunito'),
  web('Source Sans 3', ['Source Sans Pro', 'Source Sans']),
  web('Noto Sans'),
  web('Noto Serif'),
  web('Work Sans'),
  web('DM Sans'),
  web('Manrope'),
  web('PT Sans'),
  web('PT Serif'),
  web('IBM Plex Sans'),
  web('Oswald'),
  web('Raleway'),
  web('Merriweather'),
  web('Ubuntu'),
  web('Rubik'),
  web('Mulish'),
  web('Karla'),
  web('Fira Sans'),
  web('JetBrains Mono'),
  web('Source Code Pro'),
  system('Arial', ['Arial MT', 'ArialMT'], ['Arimo']),
  system('Helvetica'),
  system('Helvetica Neue'),
  system('SF Pro', ['SF Pro Text', 'SF Pro Display', '.SF NS']),
  system('Segoe UI'),
  system('Times New Roman', ['TimesNewRomanPSMT'], ['Tinos']),
  system('Times'),
  system('Georgia'),
  system('Cambria'),
  system('Palatino'),
  system('Courier New', [], ['Cousine']),
  system('Menlo'),
  system('Monaco'),
  system('Consolas'),
  system('SF Mono'),
  system('Arimo'),
  system('Tinos'),
  system('Cousine'),
])

const norm = (value: string) => value.normalize('NFKC').replace(/[\s_-]+/g, '').toLowerCase()
const WEIGHT_WORDS: ReadonlyArray<readonly [string, number]> = [
  ['extrablack', 950], ['ultrablack', 950], ['extrabold', 800], ['ultrabold', 800],
  ['semibold', 600], ['demibold', 600], ['extralight', 200], ['ultralight', 200],
  ['hairline', 100], ['medium', 500], ['regular', 400], ['normal', 400], ['roman', 400],
  ['black', 900], ['heavy', 900], ['bold', 700], ['light', 300], ['thin', 100], ['book', 400],
]
export type StyleStretch = 'normal' | 'condensed' | 'expanded'
export type ParsedStyle = { weight?: number; italic: boolean; stretch: StyleStretch }

type StyleWord = readonly [string, 'weight' | 'italic' | StyleStretch, number?]
const STYLE_WORDS = ([
  ...WEIGHT_WORDS.map(([word, weight]) => [word, 'weight', weight] as const),
  ['italic', 'italic'], ['oblique', 'italic'],
  ['condensed', 'condensed'], ['narrow', 'condensed'],
  ['expanded', 'expanded'], ['extended', 'expanded'],
] satisfies StyleWord[]).sort((a, b) => b[0].length - a[0].length)

function consumeStyle(token: string): ParsedStyle | undefined {
  if (!token) return { italic: false, stretch: 'normal' }
  if (/^\d{1,4}$/.test(token)) {
    const weight = Number(token)
    if (weight >= 1 && weight <= 1000) return { weight, italic: false, stretch: 'normal' }
  }
  for (const [word, kind, value] of STYLE_WORDS) {
    const apply = (rest: ParsedStyle): ParsedStyle => {
      if (kind === 'weight') return { ...rest, weight: rest.weight ?? value }
      if (kind === 'italic') return { ...rest, italic: true }
      return { ...rest, stretch: rest.stretch === 'normal' ? kind : rest.stretch }
    }
    if (token === word) return apply({ italic: false, stretch: 'normal' })
    if (token.startsWith(word)) {
      const rest = consumeStyle(token.slice(word.length))
      if (rest) return apply(rest)
    }
    if (token.endsWith(word) && token.length > word.length) {
      const rest = consumeStyle(token.slice(0, -word.length))
      if (rest) return apply(rest)
    }
  }
  return undefined
}

/** Whole-token style parse. "Missing Bold" is not a weight; "Bold" and "SemiBold" are. */
export function parseFontStyle(style: string): ParsedStyle {
  return consumeStyle(norm(style)) ?? { italic: false, stretch: 'normal' }
}

export function recognizedFontStyle(style: string): boolean {
  if (!style.trim()) return true
  return consumeStyle(norm(style)) !== undefined
}

export type FontFaceInfo = {
  family: string
  style?: string
  postscript?: string
  weight?: number
  italic?: boolean
  variable?: boolean
  axes?: ReadonlyArray<{ tag: string; min: number; max: number; default?: number }>
}
export type StyleMatchKind = 'exact' | 'alias' | 'variable' | 'nearest'
export type StyleMatch<T> = { face: T; kind: StyleMatchKind; distance: number }

type Split = { family: string; style: string; entry?: CatalogFamily; rewritten?: string; recognized: boolean }

function styleTail(name: string, label: string): string | undefined {
  const foldedName = name.normalize('NFKC').toLowerCase()
  const foldedLabel = label.normalize('NFKC').toLowerCase()
  let nameIndex = 0
  let labelIndex = 0
  const separator = /[\s_-]/
  while (labelIndex < foldedLabel.length && nameIndex < foldedName.length) {
    if (separator.test(foldedName[nameIndex]!)) { nameIndex++; continue }
    if (separator.test(foldedLabel[labelIndex]!)) { labelIndex++; continue }
    if (foldedName[nameIndex] !== foldedLabel[labelIndex]) return undefined
    nameIndex++; labelIndex++
  }
  if (labelIndex !== foldedLabel.length) return undefined
  const rest = foldedName.slice(nameIndex).replace(/[\s_-]/g, '')
  if (rest && !separator.test(foldedName[nameIndex] ?? '') && !recognizedFontStyle(rest)) return undefined
  return name.slice(nameIndex).replace(/^[\s_-]+/, '')
}

export function catalogEntryFor(name: string): { entry: CatalogFamily; style: string } | undefined {
  let best: { entry: CatalogFamily; style: string; length: number } | undefined
  for (const entry of FONT_CATALOG) {
    for (const label of [entry.family, ...entry.aliases]) {
      const tail = styleTail(name, label)
      if (tail === undefined) continue
      const length = norm(label).length
      if (!best || length > best.length) best = { entry, style: tail, length }
    }
  }
  return best ? { entry: best.entry, style: best.style } : undefined
}

function findExact<T extends FontFaceInfo>(name: string, fonts: readonly T[]): T | undefined {
  const wrapped = fonts.map((face, index) => ({ family: face.family, style: face.style || '', postscript: face.postscript || '', index }))
  const hit = matchFont(name, wrapped as Array<FontIdentity & { index: number }>)
  return hit ? fonts[hit.index] : undefined
}

function splitRequest<T extends FontFaceInfo>(name: string, fonts: readonly T[]): Split | undefined {
  const catalog = catalogEntryFor(name)
  if (catalog) {
    const rewritten = catalog.style ? `${catalog.entry.family} ${catalog.style}` : catalog.entry.family
    return { family: catalog.entry.family, style: catalog.style, entry: catalog.entry, rewritten, recognized: recognizedFontStyle(catalog.style) }
  }
  let best: { family: string; style: string; length: number } | undefined
  for (const face of fonts) {
    const tail = styleTail(name, face.family)
    if (tail === undefined || !recognizedFontStyle(tail)) continue
    const length = norm(face.family).length
    if (!best || length > best.length) best = { family: face.family, style: tail, length }
  }
  return best ? { ...best, recognized: true } : undefined
}

function familyKeys(split: Split): Set<string> {
  const keys = new Set([norm(split.family)])
  if (split.entry) {
    keys.add(norm(split.entry.family))
    for (const alias of split.entry.aliases) keys.add(norm(alias))
  } else {
    const entry = catalogEntryFor(split.family)
    if (entry && !entry.style) {
      keys.add(norm(entry.entry.family))
      for (const alias of entry.entry.aliases) keys.add(norm(alias))
    }
  }
  return keys
}

function postscriptStyle(face: FontFaceInfo): string {
  const postscript = face.postscript || ''
  const key = norm(postscript)
  const family = norm(face.family)
  if (family && key.startsWith(family)) return key.slice(family.length)
  const dash = postscript.lastIndexOf('-')
  return dash >= 0 ? postscript.slice(dash + 1) : ''
}

function describeFace(face: FontFaceInfo): ParsedStyle & { variable: boolean; axes?: FontFaceInfo['axes'] } {
  const fromStyle = parseFontStyle(face.style || '')
  const fromPostscript = parseFontStyle(postscriptStyle(face))
  return {
    weight: face.weight ?? fromStyle.weight ?? fromPostscript.weight,
    italic: face.italic ?? (fromStyle.italic || fromPostscript.italic),
    stretch: fromStyle.stretch !== 'normal' ? fromStyle.stretch : fromPostscript.stretch,
    variable: !!face.variable || !!face.axes?.some(axis => axis.tag === 'wght'),
    axes: face.axes,
  }
}

function weightDistance(face: ReturnType<typeof describeFace>, weight: number): number | undefined {
  const axis = face.axes?.find(item => item.tag === 'wght')
  if (face.variable && axis && Number.isFinite(axis.min) && Number.isFinite(axis.max) && weight >= axis.min && weight <= axis.max) return 0
  if (face.weight === undefined || !Number.isFinite(face.weight)) return undefined
  return Math.abs(face.weight - weight)
}

/** Exact identity first. Alias spellings (微软雅黑 → Microsoft YaHei) count as
 * exact. A variable face whose wght axis covers a named style is the next
 * choice. Nearest static weight is reported but is not an automatic match. */
export function matchFontStyle<T extends FontFaceInfo>(name: string, fonts: readonly T[]): StyleMatch<T> | undefined {
  const direct = findExact(name, fonts)
  if (direct) return { face: direct, kind: 'exact', distance: 0 }
  const split = splitRequest(name, fonts)
  if (!split) return undefined
  if (split.rewritten && norm(split.rewritten) !== norm(name)) {
    const aliased = findExact(split.rewritten, fonts)
    if (aliased) return { face: aliased, kind: 'alias', distance: 0 }
  }
  if (!split.recognized) return undefined
  const keys = familyKeys(split)
  const want = parseFontStyle(split.style)
  const weight = want.weight ?? 400
  let candidates = fonts.filter(face => keys.has(norm(face.family))).map(face => ({ face, described: describeFace(face) }))
  candidates = candidates.filter(item => item.described.italic === want.italic)
  if (!candidates.length) return undefined
  const stretched = candidates.filter(item => item.described.stretch === want.stretch)
  if (!stretched.length) return undefined
  candidates = stretched
  const scored = candidates.flatMap(item => {
    const distance = weightDistance(item.described, weight)
    return distance === undefined ? [] : [{ ...item, distance }]
  })
  if (!scored.length) return undefined
  const best = Math.min(...scored.map(item => item.distance))
  const winners = scored.filter(item => item.distance === best)
  const staticWeight = winners.filter(item => item.distance === 0 && !item.described.variable && item.described.weight === weight)
  const chosen = staticWeight.length === 1 ? staticWeight : winners.length === 1 ? winners : winners.filter(item => item.described.variable && item.distance === 0)
  if (chosen.length !== 1) return undefined
  const winner = chosen[0]!
  const covered = winner.distance === 0 && winner.described.variable && !!winner.described.axes?.some(axis => axis.tag === 'wght' && weight >= axis.min && weight <= axis.max)
  return { face: winner.face, distance: winner.distance, kind: covered && split.style ? 'variable' : 'nearest' }
}

/** Installed-face resolution used when matching a document's original names.
 * Nearest static weights stay in the missing-font list until the user confirms. */
export function resolveListedFace<T extends FontFaceInfo>(name: string, fonts: readonly T[]): T | undefined {
  const hit = matchFontStyle(name, fonts)
  // Distance 0 is a real weight-class or axis hit. A nonzero distance is only
  // a suggestion: Black must not silently become Bold.
  if (!hit || (hit.kind === 'nearest' && hit.distance !== 0)) return undefined
  return hit.face
}

export type SuggestionKind = 'exact' | 'alias' | 'variable' | 'nearest' | 'substitute' | 'builtin'
export type FontSuggestion<T> = { face?: T; fontId?: string; kind: SuggestionKind; distance: number; scripts: readonly FontScript[] }

const compactFontName = (value: string) => value.normalize('NFKC').replace(/[\s_-]+/g, '').toLowerCase()

/** The package ships ABeeZee Regular only. Another face must not inherit that file's line breaks. */
export function unshippedAbeezeeFace(name: string): boolean {
  const compact = compactFontName(name)
  if (!compact.startsWith('abeezee')) return false
  return compact !== 'abeezee' && compact !== 'abeezeeregular' && compact !== 'abeezeenormal' && compact !== 'abeezeeroman'
}

export function abeezeeAbsentFaceDiagnosis(name: string): string | undefined {
  if (!unshippedAbeezeeFace(name)) return
  return `字体 ${name} 没有同名随包文件。ABeeZee 只随包 Regular，不能把 Regular 的换行当成这个请求的结果。文字已保留，显示用当前回退。`
}

export function suggestFontFace<T extends FontFaceInfo & { id?: string }>(name: string, fonts: readonly T[]): FontSuggestion<T> {
  const entry = catalogEntryFor(name)?.entry
  const scripts = entry?.scripts ?? []
  const hit = matchFontStyle(name, fonts)
  // A nearest Regular face is a different request. Do not offer its advances.
  if (hit && !unshippedAbeezeeFace(name) && (hit.kind !== 'nearest' || hit.distance < 1000)) {
    return { face: hit.face, fontId: hit.face.id, kind: hit.kind, distance: hit.distance, scripts }
  }
  for (const substitute of entry?.substitutes ?? []) {
    const substituteEntry = FONT_CATALOG.find(item => item.family === substitute)
    const labels = substituteEntry ? [substituteEntry.family, ...substituteEntry.aliases] : [substitute]
    for (const label of labels) {
      const face = findExact(label, fonts) ?? fonts.find(item => norm(item.family) === norm(label))
      if (face) return { face, fontId: face.id, kind: 'substitute', distance: 1000, scripts }
    }
  }
  const builtin = fonts.find(face => face.id === 'default') ?? fonts.find(face => norm(face.family) === norm(BUNDLED_NOTO_SANS_SC.family))
  return { face: builtin, fontId: builtin?.id ?? 'default', kind: 'builtin', distance: 1000, scripts }
}
