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
const casing = (value: unknown): TextRun['textCase'] => value === 'UPPER' ? 'upper' : value === 'LOWER' ? 'lower' : value === 'ORIGINAL' ? 'original' : undefined

/** Embedded-schema UTF-16 style IDs, indexed once rather than searching the
 * style table per character. Original text stays editable and unmodified. */
export function importFigTextRuns(node: DesignNode, record: any, warnings: Set<string>) {
  const styles = new Map<number, any>((record.textData?.styleOverrideTable || []).map((s: any)=>[s.styleID,s]))
  const ids = record.textData?.characterStyleIDs || []
  const runs: TextRun[] = [], fonts: Record<string,string> = {}
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
      run.color=`color(srgb ${r} ${g} ${b} / ${a*(fill.opacity ?? 1)})`
    } else if (fill) warnings.add('文字片段非纯色填充尚需核对')
    if (style.textDecoration === 'UNDERLINE') run.underline=true
    if (style.textDecoration === 'STRIKETHROUGH') run.strikethrough=true
    const font=fontName(style.fontName)
    if (font) fonts[String(runs.length)]=font
    for (const key of ['lineHeight','letterSpacing','textAlignHorizontal'])
      if (style[key] !== undefined) warnings.add(`文字片段 ${key} 尚需核对`)
    runs.push(run); previous=id
  }
  if (runs.length) node.textRuns=runs
  return {style:fontName(record.fontName),runs:fonts}
}
