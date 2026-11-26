import type { Editor } from './engine'
import { defaultTextStyle, type DesignNode, type TextListStyle, type TextParagraph, type TextRun, type TextStyle } from './model'
import { applyWholeTextStyle, styleTextRange } from './text'
import type { ShortcutAction } from './shortcut-profiles'

/** Text commands shared by canvas selection and the inline editor.
 * Key mappings are defined in shortcut-profiles for each keyboard layout. */
export const figmaTextCommands = [
  'decrease-font-size', 'increase-font-size',
  'decrease-font-weight', 'increase-font-weight',
  'decrease-letter-spacing', 'increase-letter-spacing',
  'decrease-line-height', 'increase-line-height',
  'toggle-text-underline', 'text-bullet-list', 'text-numbered-list',
] as const
export type FigmaTextCommand = typeof figmaTextCommands[number]
export function isFigmaTextCommand(command: ShortcutAction): command is FigmaTextCommand {
  return (figmaTextCommands as readonly string[]).includes(command)
}
export function figmaTextCommandRepeats(command: FigmaTextCommand) {
  return command === 'decrease-font-size' || command === 'increase-font-size'
    || command === 'decrease-font-weight' || command === 'increase-font-weight'
    || command === 'decrease-letter-spacing' || command === 'increase-letter-spacing'
    || command === 'decrease-line-height' || command === 'increase-line-height'
}
const labels: Record<FigmaTextCommand, string> = {
  'decrease-font-size': '调整字号', 'increase-font-size': '调整字号',
  'decrease-font-weight': '调整字重', 'increase-font-weight': '调整字重',
  'decrease-letter-spacing': '调整字距', 'increase-letter-spacing': '调整字距',
  'decrease-line-height': '调整行高', 'increase-line-height': '调整行高',
  'toggle-text-underline': '下划线', 'text-bullet-list': '项目符号列表', 'text-numbered-list': '编号列表',
}
const roundDesign = (value: number) => Math.round(value * 1e6) / 1e6
function stepFontSize(size: number, delta: 1 | -1) {
  const next = size + delta
  return next >= 1 && next <= 4096 ? next : undefined
}
function stepWeight(weight: number, delta: 1 | -1) {
  const next = Math.min(1000, Math.max(1, weight + delta * 100))
  return next === weight ? undefined : next
}
function stepTracking(current: number, fontSize: number, delta: 1 | -1) {
  const next = Math.min(1000, Math.max(-1000, roundDesign(current + delta * fontSize * 0.01)))
  return next === current ? undefined : next
}
function stepLine(multiplier: number, fontSize: number, delta: 1 | -1) {
  const next = Math.min(10, Math.max(0.1, roundDesign((multiplier * fontSize + delta) / fontSize)))
  return next === multiplier ? undefined : next
}
function deltaOf(command: FigmaTextCommand): 1 | -1 {
  return command.startsWith('decrease') ? -1 : 1
}
function ensureStyle(node: DesignNode): TextStyle {
  node.textStyle ??= defaultTextStyle()
  return node.textStyle
}
function coversWholeText(node: DesignNode, range: readonly [number, number]) {
  return range[0] === 0 && range[1] === node.text.length
}
function paragraphSpans(text: string) {
  const spans: { start: number; end: number }[] = []
  const breaks = /\r\n|[\n\r\u2028\u2029]/g
  let start = 0
  for (const match of text.matchAll(breaks)) {
    spans.push({ start, end: match.index })
    start = match.index + match[0].length
  }
  spans.push({ start, end: text.length })
  return spans
}
function paragraphsOverlapping(node: DesignNode, range: readonly [number, number]) {
  const [start, end] = range
  const spans = paragraphSpans(node.text)
  if (start === end) {
    const found = [...spans].reverse().find(span => span.start <= start && start <= span.end)
    return found ? [found] : []
  }
  return spans.filter(span => span.start < end && span.end > start)
}
function runAt(node: DesignNode, index: number) {
  return (node.textRuns ?? []).find(run => run.start <= index && (index < run.end || index === node.text.length && run.end === index))
}
function listKindAt(node: DesignNode, index: number): TextListStyle | undefined {
  const own = runAt(node, index)?.paragraph?.list
  if (own === 'none') return undefined
  if (own === 'bullet' || own === 'ordered') return own
  return node.textStyle?.list
}
export function textSelectionIsList(node: DesignNode, range: readonly [number, number]) {
  return node.kind === 'text' && paragraphsOverlapping(node, range).some(span => listKindAt(node, span.start) !== undefined)
}
function levelAt(node: DesignNode, index: number) {
  return runAt(node, index)?.paragraph?.listLevel ?? node.textStyle?.listLevel ?? 0
}
function paragraphBase(node: DesignNode, existing?: TextParagraph): TextParagraph {
  return {
    align: existing?.align ?? node.textStyle?.align ?? 'start',
    minimumLineHeight: existing?.minimumLineHeight ?? 0,
    maximumLineHeight: existing?.maximumLineHeight ?? 0,
    spacing: existing?.spacing ?? node.textStyle?.paragraphSpacing ?? 0,
    indent: existing?.indent ?? node.textStyle?.paragraphIndent ?? 0,
  }
}
function graphemeEnd(text: string, index: number) {
  if (index < 0 || index >= text.length) return undefined
  for (const part of new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(text)) {
    if (part.index === index) return part.index + part.segment.length
    if (part.index > index) return undefined
  }
  return undefined
}
function onGrapheme(text: string, index: number) {
  if (index === 0 || index === text.length) return true
  for (const part of new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(text)) {
    if (part.index === index) return true
  }
  return false
}
function writeParagraph(node: DesignNode, paragraph: { start: number; end: number }, value: TextParagraph) {
  if (paragraph.start >= paragraph.end) return false
  const end = graphemeEnd(node.text, paragraph.start)
  if (end === undefined || end > paragraph.end || !onGrapheme(node.text, end)) return false
  styleTextRange(node, paragraph.start, end, { paragraph: value })
  return true
}
function paragraphOverride(node: DesignNode) {
  return (node.textRuns ?? []).some(run => run.paragraph?.list !== undefined || run.paragraph?.listLevel !== undefined)
}
function setNodeList(node: DesignNode, kind: TextListStyle) {
  const style = ensureStyle(node)
  const dirty = paragraphOverride(node)
  if (style.list === kind && !dirty) return false
  style.list = kind
  delete style.listLevel
  for (const run of node.textRuns ?? []) if (run.paragraph) {
    delete run.paragraph.list
    delete run.paragraph.listLevel
  }
  return true
}
function setList(node: DesignNode, kind: TextListStyle, range: 'all' | readonly [number, number]) {
  const spans = range === 'all' ? paragraphSpans(node.text) : paragraphsOverlapping(node, range)
  if (!spans.length) return false
  if (spans.length === paragraphSpans(node.text).length) return setNodeList(node, kind)
  let changed = false
  for (const span of spans) {
    const existing = runAt(node, span.start)?.paragraph
    if (existing?.list === kind && existing.listLevel === undefined) continue
    changed = writeParagraph(node, span, { ...paragraphBase(node, existing), list: kind }) || changed
  }
  return changed
}
export function adjustListIndent(node: DesignNode, range: readonly [number, number], direction: 1 | -1) {
  if (node.kind !== 'text' || node.locked) return false
  const targets = paragraphsOverlapping(node, range).filter(span => listKindAt(node, span.start))
  if (!targets.length) return false
  if (paragraphSpans(node.text).length === 1 && !paragraphOverride(node)) {
    const style = node.textStyle
    if (!style?.list) return false
    const next = (style.listLevel ?? 0) + direction
    if (next < 0 || next > 4) return false
    if (next === 0) delete style.listLevel
    else style.listLevel = next
    return true
  }
  let changed = false
  for (const span of targets) {
    const next = levelAt(node, span.start) + direction
    if (next < 0 || next > 4) continue
    const existing = runAt(node, span.start)?.paragraph
    const kind = listKindAt(node, span.start)
    if (!kind) continue
    const value = { ...paragraphBase(node, existing), list: kind, listLevel: next }
    changed = writeParagraph(node, span, value) || changed
  }
  return changed
}
function slices(node: DesignNode, start: number, end: number) {
  const style = node.textStyle
  const base = {
    fontSize: node.fontSize,
    weight: style?.weight ?? 400,
    letter: style?.letterSpacing ?? 0,
    line: style?.lineHeightPixels !== undefined ? style.lineHeightPixels / node.fontSize : style?.lineHeight ?? 1.35,
  }
  const pieces: { start: number; end: number; fontSize: number; weight: number; letter: number; line: number }[] = []
  let cursor = start
  for (const run of [...(node.textRuns ?? [])].sort((a, b) => a.start - b.start)) {
    if (run.end <= start || run.start >= end) continue
    const from = Math.max(run.start, start)
    const to = Math.min(run.end, end)
    if (from > cursor) pieces.push({ start: cursor, end: from, ...base })
    pieces.push({
      start: from, end: to,
      fontSize: run.fontSize ?? base.fontSize,
      weight: run.weight ?? base.weight,
      letter: run.letterSpacing ?? base.letter,
      line: run.lineHeight ?? (style?.lineHeightPixels !== undefined
        ? style.lineHeightPixels / (run.fontSize ?? base.fontSize) : base.line),
    })
    cursor = to
  }
  if (cursor < end) pieces.push({ start: cursor, end, ...base })
  return pieces
}
function mapRange(node: DesignNode, start: number, end: number, patchFor: (piece: ReturnType<typeof slices>[number]) => Partial<TextRun> | undefined) {
  if (!onGrapheme(node.text, start) || !onGrapheme(node.text, end)) return false
  let changed = false
  for (const piece of slices(node, start, end)) {
    const patch = patchFor(piece)
    if (!patch || !onGrapheme(node.text, piece.start) || !onGrapheme(node.text, piece.end)) continue
    styleTextRange(node, piece.start, piece.end, patch)
    changed = true
  }
  return changed
}
function rangeUnderlined(node: DesignNode, start: number, end: number) {
  let cursor = start
  for (const run of [...(node.textRuns ?? [])].sort((a, b) => a.start - b.start)) {
    if (run.end <= cursor) continue
    if (run.start > cursor || !run.underline) return false
    cursor = Math.min(end, run.end)
    if (cursor >= end) return start < end
  }
  return false
}
function toggleUnderline(node: DesignNode, range: 'all' | readonly [number, number]) {
  const start = range === 'all' ? 0 : range[0]
  const end = range === 'all' ? node.text.length : range[1]
  if (start === end) {
    if (!node.text.length) return false
    const span = caretSpan(node, start)
    return toggleUnderline(node, span === 'all' ? [0, node.text.length] : span)
  }
  if (start >= end || !onGrapheme(node.text, start) || !onGrapheme(node.text, end)) return false
  styleTextRange(node, start, end, { underline: !rangeUnderlined(node, start, end) })
  return true
}
function caretSpan(node: DesignNode, offset: number): 'all' | readonly [number, number] {
  const run = runAt(node, offset)
  if (!run || (run.start === 0 && run.end === node.text.length)) return 'all'
  return [run.start, run.end]
}
function adjustSize(node: DesignNode, delta: 1 | -1, range: 'all' | readonly [number, number]) {
  if (range === 'all' || coversWholeText(node, range)) {
    let changed = false
    const next = stepFontSize(node.fontSize, delta)
    if (next !== undefined) { node.fontSize = next; changed = true }
    for (const run of node.textRuns ?? []) if (run.fontSize !== undefined) {
      const runNext = stepFontSize(run.fontSize, delta)
      if (runNext !== undefined) { run.fontSize = runNext; changed = true }
    }
    return changed
  }
  const [start, end] = range
  if (start === end) return adjustSize(node, delta, caretSpan(node, start))
  return mapRange(node, start, end, piece => {
    const next = stepFontSize(piece.fontSize, delta)
    return next === undefined ? undefined : { fontSize: next }
  })
}
function adjustWeight(node: DesignNode, delta: 1 | -1, range: 'all' | readonly [number, number]) {
  if (range === 'all' || coversWholeText(node, range)) {
    let changed = false
    const next = stepWeight(node.textStyle?.weight ?? 400, delta)
    if (next !== undefined) { ensureStyle(node).weight = next; changed = true }
    for (const run of node.textRuns ?? []) if (run.weight !== undefined) {
      const runNext = stepWeight(run.weight, delta)
      if (runNext !== undefined) { run.weight = runNext; changed = true }
    }
    return changed
  }
  const [start, end] = range
  if (start === end) return adjustWeight(node, delta, caretSpan(node, start))
  return mapRange(node, start, end, piece => {
    const next = stepWeight(piece.weight, delta)
    return next === undefined ? undefined : { weight: next }
  })
}
function adjustTracking(node: DesignNode, delta: 1 | -1, range: 'all' | readonly [number, number]) {
  if (range === 'all' || coversWholeText(node, range)) {
    let changed = false
    const next = stepTracking(node.textStyle?.letterSpacing ?? 0, node.fontSize, delta)
    if (next !== undefined) { ensureStyle(node).letterSpacing = next; changed = true }
    for (const run of node.textRuns ?? []) if (run.letterSpacing !== undefined) {
      const runNext = stepTracking(run.letterSpacing, run.fontSize ?? node.fontSize, delta)
      if (runNext !== undefined) { run.letterSpacing = runNext; changed = true }
    }
    return changed
  }
  const [start, end] = range
  if (start === end) return adjustTracking(node, delta, caretSpan(node, start))
  return mapRange(node, start, end, piece => {
    const next = stepTracking(piece.letter, piece.fontSize, delta)
    return next === undefined ? undefined : { letterSpacing: next }
  })
}
function adjustLine(node: DesignNode, delta: 1 | -1, range: 'all' | readonly [number, number]) {
  if (range === 'all' || coversWholeText(node, range)) {
    let changed = false
    const style = node.textStyle
    const pixels = style?.lineHeightPixels
    if (pixels === undefined) {
      const next = stepLine(style?.lineHeight ?? 1.35, node.fontSize, delta)
      if (next !== undefined) {
        applyWholeTextStyle(node, { lineHeight: next,
          ...(style?.lineHeightAuto ? { lineBoxBaseline: 'figma-pixel-leading' as const } : {}) })
        changed = true
      }
    } else {
      const next = Math.max(.1, Math.min(40960, pixels + delta))
      if (next !== pixels) {
        applyWholeTextStyle(node, { lineHeightPixels: next,
          lineHeight: Math.max(.1, Math.min(10, next / node.fontSize)) })
        changed = true
      }
    }
    for (const run of node.textRuns ?? []) if (run.lineHeight !== undefined) {
      const runNext = stepLine(run.lineHeight, run.fontSize ?? node.fontSize, delta)
      if (runNext !== undefined) { run.lineHeight = runNext; changed = true }
    }
    return changed
  }
  const [start, end] = range
  if (start === end) return adjustLine(node, delta, caretSpan(node, start))
  return mapRange(node, start, end, piece => {
    const next = stepLine(piece.line, piece.fontSize, delta)
    return next === undefined ? undefined : { lineHeight: next }
  })
}
export function adjustTextNode(node: DesignNode, command: FigmaTextCommand, range: 'all' | readonly [number, number] = 'all') {
  if (node.kind !== 'text' || node.locked) return false
  if (command === 'text-bullet-list' || command === 'text-numbered-list') return setList(node, command === 'text-bullet-list' ? 'bullet' : 'ordered', range)
  if (command === 'toggle-text-underline') return toggleUnderline(node, range)
  const delta = deltaOf(command)
  if (command.endsWith('font-size')) return adjustSize(node, delta, range)
  if (command.endsWith('font-weight')) return adjustWeight(node, delta, range)
  if (command.includes('letter-spacing')) return adjustTracking(node, delta, range)
  return adjustLine(node, delta, range)
}
function committed(editor: Editor, version: number) {
  return editor.state.version !== version
}
export function applyFigmaTextShortcut(editor: Editor, command: FigmaTextCommand) {
  if (editor.state.busy || editor.interactionActive) return false
  const ids = editor.state.selection.filter(id => {
    const node = editor.state.doc.nodes[id]
    return !!node && node.kind === 'text' && !node.locked
  })
  if (!ids.length) return false
  const version = editor.state.version
  editor.update(ids, node => { adjustTextNode(node, command, 'all') }, labels[command])
  return committed(editor, version)
}
export function commitFigmaTextCommand(editor: Editor, id: string, command: FigmaTextCommand, range: readonly [number, number]) {
  const node = editor.state.doc.nodes[id]
  if (!node || node.kind !== 'text' || node.locked || editor.state.busy || editor.interactionActive) return false
  const version = editor.state.version
  editor.update([id], current => { adjustTextNode(current, command, range) }, labels[command])
  return committed(editor, version)
}
export function commitListIndent(editor: Editor, id: string, range: readonly [number, number], direction: 1 | -1) {
  const node = editor.state.doc.nodes[id]
  if (!node || node.kind !== 'text' || node.locked || editor.state.busy || editor.interactionActive) return false
  const version = editor.state.version
  editor.update([id], current => { adjustListIndent(current, range, direction) }, '调整列表缩进')
  return committed(editor, version)
}
