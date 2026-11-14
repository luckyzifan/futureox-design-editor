import type { Editor } from './engine'
import { BUNDLED_NOTO_SANS_SC, suggestFontFace, type FontFaceInfo, type FontScript, type SuggestionKind } from './font-catalog'
import { fontTargets, type FontEditResult } from './font-management'
import { preserveUnmatchedSourceRuns, resolveSourceFonts, sourceFonts, sourceNameResolved } from './font-matching'
import { defaultTextStyle, type DesignDocument } from './model'
import { commitPendingEdits } from './pending-edits'

export type FontDecision = { name: string; fontId: string }
export type DocumentFace = FontFaceInfo & { id: string }

export function bundledFaceChoices(faces: readonly DocumentFace[]): DocumentFace[] {
  if (faces.some(face => face.id === 'default')) return [...faces]
  return [{ id: 'default', family: BUNDLED_NOTO_SANS_SC.family, style: 'Regular', postscript: 'NotoSansSC-Regular', weight: BUNDLED_NOTO_SANS_SC.weight, italic: false, variable: true, axes: BUNDLED_NOTO_SANS_SC.axes }, ...faces]
}

export function suggestDocumentFont(name: string, faces: readonly DocumentFace[]) {
  return suggestFontFace(name, bundledFaceChoices(faces))
}

const blocked = (message: string): FontEditResult => ({ status: 'blocked', changedNodes: 0, changedReferences: 0, visitedNodes: 0, visitedRuns: 0, skippedLocked: 0, skippedLinked: 0, inherited: 0, message })

/** Confirm a missing source name onto a document font id, including the
 * built-in face. Original names stay in fontSources; `resolved` is what
 * clears the missing-font warning when the substitute is still `default`. */
export function applyFontSubstitutions(document: DesignDocument, decisions: readonly FontDecision[]) {
  const byName = new Map<string, string>()
  for (const decision of decisions) {
    if (!decision.name || decision.name.length > 512 || decision.fontId.length > 128) continue
    if (byName.size >= 256) break
    byName.set(decision.name, decision.fontId)
  }
  for (const fontId of byName.values()) {
    if (fontId !== 'default' && !Object.hasOwn(document.fonts || {}, fontId)) throw Error('字体资源不存在，请重新选择')
  }
  const targets = fontTargets(document, { kind: 'document' })
  let changedNodes = 0
  let changedReferences = 0
  let deferredInherited = 0
  for (const target of targets.targets) {
    const node = document.nodes[target.id]
    const source = sourceFonts(document, node)
    const base = node.textStyle?.fontId ?? 'default'
    const styleName = target.style && typeof source.style === 'string' ? source.style : undefined
    const styleDecision = styleName ? byName.get(styleName) : undefined
    // A style-only override cannot pin inherited runs. Leave the base unmatched
    // rather than retargeting a run this edit is not allowed to write.
    const inheritedRun = !target.runs && Object.entries(source.runs || {}).some(([index, name]) => {
      const run = node.textRuns?.[Number(index)]
      return run && typeof name === 'string' && run.fontId === undefined && !sourceNameResolved(source, name)
    })
    if (styleDecision && base === 'default' && !sourceNameResolved(source, styleName!) && inheritedRun) {
      deferredInherited++
      continue
    }
    let changed = 0
    const resolved: string[] = []
    if (target.runs) {
      for (const [index, name] of Object.entries(source.runs || {})) {
        const run = node.textRuns?.[Number(index)]
        const fontId = typeof name === 'string' ? byName.get(name) : undefined
        if (!run || !fontId || sourceNameResolved(source, name) || (run.fontId ?? base) !== 'default') continue
        run.fontId = fontId
        resolved.push(name)
        changed++
      }
    }
    if (styleDecision && styleName && base === 'default' && !sourceNameResolved(source, styleName)) {
      if (target.runs) preserveUnmatchedSourceRuns(node, source)
      if (node.textStyle) node.textStyle.fontId = styleDecision
      else node.textStyle = { ...defaultTextStyle(), fontId: styleDecision }
      resolved.push(styleName)
      changed++
    }
    changed += resolveSourceFonts(document, node, source, resolved)
    if (changed) { changedNodes++; changedReferences += changed }
  }
  return { ...targets, changedNodes, changedReferences, deferredInherited }
}

export function substituteMissingFonts(editor: Editor, decisions: readonly FontDecision[]): FontEditResult {
  if (!commitPendingEdits(editor)) return blocked(editor.state.message)
  if (!decisions.length) return blocked('没有可替换的缺失字体')
  let changedNodes = 0
  let changedReferences = 0
  let deferredInherited = 0
  const targets = fontTargets(editor.state.doc, { kind: 'document' })
  const change = editor.change('替换缺失字体', document => {
    const applied = applyFontSubstitutions(document, decisions)
    changedNodes = applied.changedNodes
    changedReferences = applied.changedReferences
    deferredInherited = applied.deferredInherited
  }, undefined, targets.targets.map(target => target.id))
  const skipped = targets.skippedLocked + targets.skippedLinked
  return {
    ...targets,
    inherited: targets.inherited + deferredInherited,
    status: change?.status === 'rejected' ? 'rejected' : change?.status === 'committed' ? 'committed' : 'unchanged',
    changedNodes, changedReferences, visitedRuns: 0,
    message: change?.status === 'rejected' ? change.message : `已确认 ${changedReferences} 处缺失字体（${changedNodes} 个文字图层）${skipped ? `；跳过 ${targets.skippedLocked} 个锁定、${targets.skippedLinked} 个共享样式图层` : ''}${deferredInherited ? `；跳过 ${deferredInherited} 个含继承字体片段的图层` : ''}`,
  }
}

export function suggestionNote(kind: SuggestionKind, scripts: readonly FontScript[]): 'exact' | 'nearest' | 'han-variant' | 'builtin' {
  if (kind === 'exact' || kind === 'alias' || kind === 'variable') return 'exact'
  if (kind === 'nearest') return 'nearest'
  if (scripts.some(script => script === 'tc' || script === 'jp' || script === 'kr') && !scripts.includes('sc')) return 'han-variant'
  return 'builtin'
}
