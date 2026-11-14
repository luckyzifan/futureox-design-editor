import { defaultTextStyle, type DesignDocument, type DesignNode, type TextRun, type TextStyle } from './model'
import { remapSourceFontRuns, type FontSourceRecord } from './font-matching'

/** Inspector formatting applies to the entire layer; range formatting stays in styleTextRange. */
export function applyWholeTextStyle(node: DesignNode, patch: Partial<TextStyle>) {
  if (node.kind !== 'text') return
  // Keep the existing Immer draft object. A new object made by spreading it
  // can contain nested draft arrays, which structuredClone in component
  // override capture cannot clone. Fill only absent defaults, then mutate.
  node.textStyle ??= defaultTextStyle()
  const missing = Object.fromEntries(Object.entries(defaultTextStyle()).filter(([key]) => !Object.hasOwn(node.textStyle!, key)))
  Object.assign(node.textStyle, missing, patch)
  if (patch.lineHeight !== undefined && patch.lineHeightAuto === undefined) node.textStyle.lineHeightAuto = false
  for (const run of node.textRuns || []) {
    if (patch.fontId !== undefined) delete run.fontId
    if (patch.weight !== undefined) delete run.weight
    if (run.paragraph) {
      if (patch.align !== undefined) run.paragraph.align = patch.align
      if (patch.paragraphSpacing !== undefined) run.paragraph.spacing = patch.paragraphSpacing
      if (patch.paragraphIndent !== undefined) run.paragraph.indent = patch.paragraphIndent
      if (patch.lineHeight !== undefined) run.paragraph.minimumLineHeight = run.paragraph.maximumLineHeight = patch.lineHeight * (run.fontSize ?? node.fontSize)
    }
  }
}

export function setWholeTextFontSize(node: DesignNode, size: number) {
  if (node.kind !== 'text') return
  node.fontSize = size
  for (const run of node.textRuns || []) delete run.fontSize
}

/** Layer fill edits replace range colors while preserving every other run attribute. */
export function clearWholeTextRunColor(node: DesignNode) {
  if (node.kind !== 'text') return
  for (const run of node.textRuns || []) delete run.color
}

export function importFonts(target: DesignDocument, source: DesignDocument, nodes: DesignNode[]) {
  const ids = new Set(
    nodes
      .flatMap((n) => [
        n.textStyle?.fontId,
        ...(n.textStyle?.fallbacks || []),
        ...(n.textRuns || []).map((r) => r.fontId),
      ])
      .filter((id): id is string => !!id && id !== 'default'),
  )
  for (const id of ids) {
    const resource = source.fonts?.[id]
    if (!resource) throw new Error('剪贴板缺少字体资源')
    if (target.fonts?.[id] && target.fonts[id].data !== resource.data)
      throw new Error('字体标识冲突，原文件已保留')
    target.fonts = { ...target.fonts, [id]: resource }
  }
}
const boundaries = (text: string) =>
  new Set([
    text.length,
    ...Array.from(
      new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(text),
      (g) => g.index,
    ),
  ])
export function styleTextRange(
  node: DesignNode, start: number, end: number, patch: Partial<Omit<TextRun, 'start' | 'end'>>,
  source?: FontSourceRecord,
) {
  const valid = boundaries(node.text)
  if (start >= end || !valid.has(start) || !valid.has(end)) throw new Error('请选择完整字素范围')
  const cuts = new Set([start, end, ...(node.textRuns || []).flatMap(run => [run.start, run.end])])
  const points = [...cuts].sort((a, b) => a - b), runs: TextRun[] = []
  const origins: number[] = []
  const setsFont = Object.hasOwn(patch, 'fontId')
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], b = points[i + 1]
    const origin = node.textRuns?.findIndex(run => run.start <= a && b <= run.end) ?? -1
    const old = node.textRuns?.[origin]
    const edited = a >= start && b <= end
    if (!old && !edited) continue
    runs.push({ ...old, ...(edited ? patch : {}), start: a, end: b })
    if (source?.runs) origins.push(edited && setsFont ? -1 : origin)
  }
  node.textRuns = runs
  return remapSourceFontRuns(source, origins)
}
/** Explicit half-open UTF-16 edit; never infer its position from repeated text.
 * Inserted text inherits the run containing start (right-biased); at EOF only,
 * it inherits the immediately preceding run. A gap means layer-default style.
 * Reject cross-edge grapheme joins rather than consume any unselected text. */
export function replaceTextRange(node: DesignNode, start: number, end: number, inserted: string, source?: FontSourceRecord) {
  const old = node.text, valid = boundaries(old)
  if (node.kind !== 'text' || !Number.isInteger(start) || !Number.isInteger(end) || start > end || !valid.has(start) || !valid.has(end))
    throw new Error('请选择完整字素范围')
  if (typeof inserted !== 'string' || /[\uD800-\uDFFF]/u.test(inserted)) throw new Error('插入文字必须是有效的 UTF-16')
  const text = old.slice(0, start) + inserted + old.slice(end), nextEnd = start + inserted.length
  if (text.length > 100000) throw new Error('文字不能超过 100000 个 UTF-16 单元')
  const nextBoundaries = boundaries(text)
  if (!nextBoundaries.has(start) || !nextBoundaries.has(nextEnd))
    throw new Error('插入或删除会连接选区外的字素；请扩大选区并显式提供完整字素')
  // Exact replacement is a true no-op, including the existing run segmentation.
  if (old.slice(start, end) === inserted) return
  const inherited = (node.textRuns || []).findIndex(run => start === old.length
    ? run.end === start
    : run.start <= start && start < run.end)
  const pieces = replaceRunRanges(node, start, end, nextEnd, inherited)
  if (pieces.length > 4096 || pieces.some(({ run }) => !nextBoundaries.has(run.start) || !nextBoundaries.has(run.end)))
    throw new Error('文字样式区间必须位于完整字素边界且不超过 4096 段')
  // Publish only after all local checks; callers may also use this on a draft.
  node.text = text
  if (node.textRuns) node.textRuns = pieces.map(({ run }) => run)
  if (source?.runs) return remapSourceFontRuns(source, pieces.map(({ origin }) => origin))
}

function replaceRunRanges(node: DesignNode, start: number, end: number, nextEnd: number, inherited: number) {
  const pieces: { run: TextRun; origin: number }[] = []
  const delta = nextEnd - end
  for (const [origin, run] of (node.textRuns || []).entries()) {
    if (run.start < start) pieces.push({ run: { ...run, end: Math.min(run.end, start) }, origin })
    if (run.end > end) pieces.push({
      run: { ...run, start: Math.max(run.start, end) + delta, end: run.end + delta }, origin,
    })
  }
  const run = node.textRuns?.[inherited]
  if (run && nextEnd > start) pieces.push({ run: { ...run, start, end: nextEnd }, origin: inherited })
  pieces.sort((a, b) => a.run.start - b.run.start)
  return pieces
}
/** Preserve styles outside the edit; inserted text inherits the insertion style. */
export function replaceText(node: DesignNode, text: string, source?: FontSourceRecord) {
  const old = node.text,
    oldBoundaries = boundaries(old),
    nextBoundaries = boundaries(text)
  let start = 0
  while (start < old.length && start < text.length && old[start] === text[start]) start++
  while (start && (!oldBoundaries.has(start) || !nextBoundaries.has(start))) start--
  let end = old.length,
    nextEnd = text.length
  while (end > start && nextEnd > start && old[end - 1] === text[nextEnd - 1]) {
    end--
    nextEnd--
  }
  while (end < old.length && (!oldBoundaries.has(end) || !nextBoundaries.has(nextEnd))) {
    end++
    nextEnd++
  }
  const inherited = node.textRuns?.findIndex(run => run.start <= start && start <= run.end) ?? -1
  const pieces = replaceRunRanges(node, start, end, nextEnd, inherited)
    .filter(({ run }) => run.start < run.end)
  node.text = text
  if (node.textRuns) node.textRuns = pieces.map(({ run }) => run)
  if (source?.runs) return remapSourceFontRuns(source, pieces.map(({ origin }) => origin))
}
