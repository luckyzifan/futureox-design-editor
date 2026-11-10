import type { ImportWarningSink } from './import-warnings'
import type { DesignNode, TextRun } from './model'

const weight = (style: string | undefined) => {
  const name = (style || '').toLowerCase().replace(/[\s_-]/g, '')
  if (/thin/.test(name)) return 100
  if (/extralight|ultralight/.test(name)) return 200
  if (/light/.test(name)) return 300
  if (/medium/.test(name)) return 500
  if (/semibold|demibold/.test(name)) return 600
  if (/extrabold|ultrabold/.test(name)) return 800
  if (/black|heavy/.test(name)) return 900
  if (/bold/.test(name)) return 700
  return 400
}
const fontName = (font: any): string | undefined => font?.postscript || [font?.family,font?.style].filter(Boolean).join(' ') || undefined
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
/** Figma PIXELS / PERCENT / RAW. 100% and RAW 1 are one em, not font-metric auto. */
function lineHeightMultiplier(value: any, size: number): number | undefined {
  if (!value || typeof value !== 'object' || !finite(value.value) || !(size >= 1)) return
  if (value.units === 'PIXELS') return value.value / size
  if (value.units === 'PERCENT') return value.value / 100
  if (value.units === 'RAW') return value.value
}
function letterSpacingPixels(value: any, size: number): number | undefined {
  if (!value || typeof value !== 'object' || !finite(value.value)) return
  if (value.units === 'PIXELS') return value.value
  if (value.units === 'PERCENT' && size >= 1) return size * value.value / 100
}
const casing = (value: unknown): TextRun['textCase'] => value === 'UPPER' ? 'upper' : value === 'LOWER' ? 'lower' : value === 'ORIGINAL' ? 'original' : undefined

function digestHex(bytes: unknown): string | undefined {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 20) return
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return /^[0-9a-f]{40}$/.test(hex) ? hex : undefined
}
function fontKey(font: any) {
  return [font?.family, font?.style].filter(Boolean).join('\0').toLowerCase()
}
/** SHA-1 values FIG stored on the measured face. Empty when the file has none. */
function figFontDigests(record: any) {
  const byKey = new Map<string, string>()
  for (const meta of [...(record.derivedTextData?.fontMetaData || []), ...(record.textData?.fontMetaData || [])]) {
    const digest = digestHex(meta?.fontDigest)
    const key = fontKey(meta?.key)
    if (digest && key && !byKey.has(key)) byKey.set(key, digest)
  }
  return byKey
}

/** Embedded-schema UTF-16 style IDs, indexed once rather than searching the
 * style table per character. Original text stays editable and unmodified. */
export function importFigTextRuns(node: DesignNode, record: any, warnings: ImportWarningSink, colorSpace: 'srgb' | 'display-p3' = 'srgb') {
  const styles = new Map<number, any>((record.textData?.styleOverrideTable || []).map((s: any)=>[s.styleID,s]))
  const ids = record.textData?.characterStyleIDs || []
  const runs: TextRun[] = [], fonts: Record<string,string> = {}, runDigests: Record<string, string> = {}
  const digests = figFontDigests(record)
  if (node.textStyle) node.textStyle.weight = weight(record.fontName?.style)
  let previous: unknown
  for (const segment of new Intl.Segmenter('und',{granularity:'grapheme'}).segment(node.text)) {
    const start=segment.index, end=start+segment.segment.length, id=ids[start], style=styles.get(id)
    if (id === 0 || !style) { previous=undefined; continue }
    if (id === previous && runs.at(-1)?.end === start) { runs.at(-1)!.end=end; continue }
    const run: TextRun = {start,end}
    if (Number.isFinite(style.fontSize)) run.fontSize=style.fontSize
    if (style.fontName) run.weight=weight(style.fontName.style)
    const caseValue=casing(style.textCase)
    if (caseValue) run.textCase=caseValue
    else if (style.textCase) warnings.add(`文字片段大小写 ${style.textCase} 尚需核对`)
    const fill=style.fillPaints?.[0]
    if (fill?.type==='SOLID' && fill.color) {
      const {r=0,g=0,b=0,a=1}=fill.color
      run.color=`color(${colorSpace} ${r} ${g} ${b} / ${a*(fill.opacity ?? 1)})`
    } else if (fill) warnings.add('文字片段非纯色填充尚需核对')
    if (style.textDecoration === 'UNDERLINE') run.underline=true
    if (style.textDecoration === 'STRIKETHROUGH') run.strikethrough=true
    const metricSize = Number.isFinite(style.fontSize) ? style.fontSize : node.fontSize
    const lineHeight = lineHeightMultiplier(style.lineHeight, metricSize)
    if (style.lineHeight !== undefined && (lineHeight === undefined || lineHeight < 0.1 || lineHeight > 10)) warnings.add('文字片段 lineHeight 尚需核对')
    else if (lineHeight !== undefined) run.lineHeight = lineHeight
    const tracking = letterSpacingPixels(style.letterSpacing, metricSize)
    if (style.letterSpacing !== undefined && (tracking === undefined || Math.abs(tracking) > 1000)) warnings.add('文字片段 letterSpacing 尚需核对')
    else if (tracking !== undefined) run.letterSpacing = tracking
    const font=fontName(style.fontName)
    if (font) {
      const index = String(runs.length)
      fonts[index]=font
      const digest = digests.get(fontKey(style.fontName))
      if (digest) runDigests[index] = digest
    }
    if (style.textAlignHorizontal !== undefined) warnings.add('文字片段 textAlignHorizontal 尚需核对')
    runs.push(run); previous=id
  }
  if (runs.length) node.textRuns=runs
  const style = fontName(record.fontName)
  const digest = digests.get(fontKey(record.fontName))
  return {
    ...(style ? { style } : {}),
    runs: fonts,
    ...(digest ? { digest } : {}),
    ...(Object.keys(runDigests).length ? { runDigests } : {}),
  }
}

const featureTag = /^-?[a-z0-9]{4}$/
function axisTag(variation: any): string | undefined {
  const bits = variation?.axisTag
  if (typeof bits === 'number' && Number.isInteger(bits) && bits >= 0 && bits <= 0xffffffff) {
    const bytes = [(bits >>> 24) & 255, (bits >>> 16) & 255, (bits >>> 8) & 255, bits & 255]
    const tag = String.fromCharCode(...bytes)
    if (/^[A-Za-z0-9]{4}$/.test(tag)) return tag.toLowerCase()
  }
  if (typeof variation?.axisName === 'string' && /^[A-Za-z0-9]{4}$/.test(variation.axisName)) {
    return variation.axisName.toLowerCase()
  }
  return undefined
}

/** Node-level OpenType toggles, variation axes, vertical alignment and decoration.
 * `wght` stays on the weight field. TITLE/SMALL_CAPS remain outside the text model. */
export function importFigTextExtras(node: DesignNode, record: any, warnings: ImportWarningSink) {
  const style = node.textStyle
  if (!style) return
  const features: string[] = []
  for (const [field, on] of [['toggledOnOTFeatures', true], ['toggledOffOTFeatures', false]] as const) {
    const tags = record[field]
    if (tags === undefined) continue
    if (!Array.isArray(tags)) throw new Error(`FIG ${field} 无效；原文件未修改`)
    for (const tag of tags) {
      if (typeof tag !== 'string') throw new Error(`FIG OpenType 特性 ${String(tag)} 无效；原文件未修改`)
      const mapped = `${on ? '' : '-'}${tag.toLowerCase()}`
      if (!featureTag.test(mapped)) throw new Error(`FIG OpenType 特性 ${tag} 暂不能表达；原文件未修改`)
      features.push(mapped)
    }
  }
  if (features.length > 16) throw new Error('FIG OpenType 特性超过 16 项；原文件未修改')
  if (features.length) style.features = features
  if (record.fontVariations !== undefined) {
    if (!Array.isArray(record.fontVariations)) throw new Error('FIG 字体变体轴无效；原文件未修改')
    const axes: { tag: string; value: number }[] = []
    for (const variation of record.fontVariations) {
      const value = variation?.value
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      const tag = axisTag(variation)
      if (tag === 'wght') continue
      if (!tag || !/^[a-z0-9]{4}$/.test(tag) || Math.abs(value) > 10000) {
        throw new Error(`FIG 字体变体轴 ${tag || variation?.axisTag || variation?.axisName || ''} 无效；原文件未修改`)
      }
      axes.push({ tag, value })
    }
    if (axes.length > 16) throw new Error('FIG 字体变体轴超过 16 项；原文件未修改')
    if (axes.length) style.variations = axes
  }
  const vertical = record.textAlignVertical
  if (vertical !== undefined && vertical !== 'TOP') {
    if (vertical === 'CENTER') style.verticalAlign = 'center'
    else if (vertical === 'BOTTOM') style.verticalAlign = 'bottom'
    else warnings.add(`文字垂直对齐 ${vertical} 尚需核对`)
  }
  const decoration = record.textDecoration
  if (!node.text || (decoration !== 'UNDERLINE' && decoration !== 'STRIKETHROUGH')) {
    if (decoration && decoration !== 'NONE' && decoration !== 'UNDERLINE' && decoration !== 'STRIKETHROUGH') {
      warnings.add(`文字装饰 ${decoration} 尚需核对`)
    }
    return
  }
  if (node.textRuns?.length) warnings.add(`文字装饰 ${decoration} 与片段样式并存，节点级装饰未叠加`)
  else node.textRuns = [{
    start: 0,
    end: node.text.length,
    ...(decoration === 'UNDERLINE' ? { underline: true } : { strikethrough: true }),
  }]
}
