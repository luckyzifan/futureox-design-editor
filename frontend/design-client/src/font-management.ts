import type { Editor } from './engine'
import { defaultTextStyle, type DesignDocument, type DesignNode } from './model'
import { commitPendingEdits } from './pending-edits'
import { sourceFonts, type FontResource } from './font-matching'

export const FONT_PAGE_SIZE = 40
export type FontChoice = { id: string; family: string; style?: string; postscript?: string }
const normalized = (value: string) => value.normalize('NFKC').toLocaleLowerCase().trim()
/** Metadata only: searching/paging never reads bytes or creates font previews. */
export function searchFontChoices<T extends FontChoice>(fonts: readonly T[], query: string): T[] {
  const tokens = normalized(query).split(/\s+/).filter(Boolean)
  return fonts.filter(font => {
    const text = normalized(`${font.family} ${font.style || ''} ${font.postscript || ''}`)
    return tokens.every(token => text.includes(token))
  })
}
export function documentFontChoices(doc: DesignDocument): FontChoice[] {
  return [{ id: 'default', family: 'Noto Sans SC', style: '内置' },
    ...Object.entries(doc.fonts || {}).map(([id, font]) => ({ id, family: font.family, postscript: font.postscript }))]
}
export type FontScope = { kind: 'selection'; ids: readonly string[] } | { kind: 'document' }
export type FontEditOptions = { detachSharedStyle?: boolean; includeFallbacks?: boolean; matchSourceFonts?: boolean }
type Target = { id: string; style: boolean; runs: boolean }
export type FontTargets = { targets: Target[]; skippedLocked: number; skippedLinked: number; inherited: number; visitedNodes: number }

/** One tree traversal for document locks. Explicit property selections may edit locked layers. */
export function fontTargets(doc: DesignDocument, scope: FontScope, options: FontEditOptions = {}): FontTargets {
  const result: FontTargets = { targets: [], skippedLocked: 0, skippedLinked: 0, inherited: 0, visitedNodes: 0 }
  const blocked = new Set<string>()
  if (scope.kind === 'document') {
    const stack: [string, boolean][] = doc.pages.flatMap(page => page.children.map(id => [id, false] as [string, boolean]))
    const seen = new Set<string>()
    while (stack.length) {
      const [id, parentLocked] = stack.pop()!, n = doc.nodes[id]
      if (!n || seen.has(id)) continue
      seen.add(id)
      const locked = parentLocked || n.locked
      if (locked) blocked.add(id)
      for (const child of n.children) stack.push([child, locked])
    }
  }
  const ids = scope.kind === 'document' ? Object.keys(doc.nodes) : [...new Set(scope.ids)]
  for (const id of ids) {
    result.visitedNodes++
    const n = doc.nodes[id]
    if (n?.kind !== 'text') continue
    if (blocked.has(id)) { result.skippedLocked++; continue }
    if (n.styleRefs?.textStyle && !options.detachSharedStyle) { result.skippedLinked++; continue }
    // Document replacement changes authored master fields and existing overrides.
    // Never turn an inherited instance copy into an accidental local override.
    if (scope.kind === 'document' && (n.instanceOrigin || n.instance)) {
      const owner = n.instanceOrigin?.owner || n.id, key = n.instanceOrigin?.key || '$root'
      const fields = doc.nodes[owner]?.instance?.overrides[key]
      const style = !!fields && Object.hasOwn(fields, 'textStyle'), runs = !!fields && Object.hasOwn(fields, 'textRuns')
      if (!style && !runs) { result.inherited++; continue }
      result.targets.push({ id, style, runs })
    } else result.targets.push({ id, style: true, runs: true })
  }
  return result
}

/** Read only identities the document operation is allowed to change. Locked,
 * shared-style and inherited-only fields must not consume the resource cap. */
export function unmatchedEditableSourceFonts(doc: DesignDocument): string[] {
  const names = new Set<string>()
  for (const target of fontTargets(doc, { kind: 'document' }).targets) {
    const n = doc.nodes[target.id], source = sourceFonts(doc, n), base = n.textStyle?.fontId ?? 'default'
    if (target.style && typeof source.style === 'string' && base === 'default') names.add(source.style)
    if (target.runs) for (const [index, name] of Object.entries(source.runs || {})) {
      const run = n.textRuns?.[Number(index)]
      if (run && typeof name === 'string' && (run.fontId ?? base) === 'default') names.add(name)
    }
  }
  return [...names]
}
function detachStyle(node: DesignNode) {
  if (!node.styleRefs?.textStyle) return
  delete node.styleRefs.textStyle
  if (!Object.keys(node.styleRefs).length) delete node.styleRefs
}
function assertFont(doc: DesignDocument, id: string) {
  if (id !== 'default' && !Object.hasOwn(doc.fonts || {}, id)) throw Error('字体资源不存在，请重新选择')
}
export type FontEditResult = { status: 'committed' | 'unchanged' | 'blocked' | 'rejected'; changedNodes: number; changedReferences: number; visitedNodes: number; visitedRuns: number; skippedLocked: number; skippedLinked: number; inherited: number; message: string }
const emptyResult = (message: string): FontEditResult => ({ status: 'blocked', changedNodes: 0, changedReferences: 0, visitedNodes: 0, visitedRuns: 0, skippedLocked: 0, skippedLinked: 0, inherited: 0, message })

/** Whole-layer application intentionally clears only run font overrides. */
export function applySelectionFont(editor: Editor, ids: readonly string[], fontId: string, options: FontEditOptions = {}, resource?: FontResource): FontEditResult {
  if (!commitPendingEdits(editor)) return emptyResult(editor.state.message)
  const targets = fontTargets(editor.state.doc, { kind: 'selection', ids }, options)
  if (targets.skippedLinked) { editor.notify('所选文字引用共享样式；请先勾选「转为本地文字样式」'); return emptyResult(editor.state.message) }
  if (!targets.targets.length) return emptyResult('请选择文字图层')
  let changedNodes = 0, changedReferences = 0, visitedRuns = 0
  const change = editor.change('应用所选文字字体', doc => {
    if (resource) {
      const existing = doc.fonts?.[fontId]
      if (existing && (existing.data !== resource.data || (existing.index || 0) !== (resource.index || 0))) throw Error('字体标识冲突，原字体已保留')
      doc.fonts = { ...doc.fonts, [fontId]: resource }
    }
    assertFont(doc, fontId)
    if (options.matchSourceFonts && resource?.postscript) matchSourceFontsInDocument(doc, new Map([[resource.postscript, { id: fontId, resource }]]))
    for (const { id } of targets.targets) {
      const n = doc.nodes[id]
      visitedRuns += n.textRuns?.length || 0
      if ((n.textStyle?.fontId ?? 'default') === fontId && !n.textRuns?.some(run => run.fontId !== undefined) && !(options.detachSharedStyle && n.styleRefs?.textStyle)) continue
      changedNodes++; changedReferences++
      if (options.detachSharedStyle) detachStyle(n)
      if (n.textStyle) n.textStyle.fontId = fontId
      else n.textStyle = { ...defaultTextStyle(), fontId }
      for (const run of n.textRuns || []) delete run.fontId
    }
  }, undefined, targets.targets.map(target => target.id))
  return { ...targets, status: change?.status === 'rejected' ? 'rejected' : change?.status === 'committed' ? 'committed' : 'unchanged', changedNodes, changedReferences, visitedRuns,
    message: change?.status === 'rejected' ? change.message : `已应用 ${changedNodes} 个文字图层` }
}

/** Replace references, never flatten mixed runs or change weight, size, colors or fallback order. */
export function replaceFontReferences(editor: Editor, scope: FontScope, from: string, to: string, options: FontEditOptions = {}): FontEditResult {
  if (!commitPendingEdits(editor)) return emptyResult(editor.state.message)
  const targets = fontTargets(editor.state.doc, scope, options)
  let changedNodes = 0, changedReferences = 0, visitedRuns = 0
  if (from === to) return { ...emptyResult('原字体与目标字体相同'), ...targets, status: 'unchanged' }
  const change = editor.change('批量替换文字字体', doc => {
    assertFont(doc, from); assertFont(doc, to)
    for (const target of targets.targets) {
      const n = doc.nodes[target.id], base = n.textStyle?.fontId ?? 'default'
      let changed = 0
      if (target.style && base === from) {
        if (n.textStyle) n.textStyle.fontId = to
        else n.textStyle = { ...defaultTextStyle(), fontId: to }
        changed++
      }
      if (target.style && options.includeFallbacks && n.textStyle?.fallbacks.includes(from)) {
        n.textStyle.fallbacks = n.textStyle.fallbacks.map(id => id === from ? to : id); changed++
      }
      if (target.runs) for (const run of n.textRuns || []) {
        visitedRuns++
        if (run.fontId === from) { run.fontId = to; changed++ }
      }
      if (changed) {
        if (options.detachSharedStyle) detachStyle(n)
        changedNodes++; changedReferences += changed
      }
    }
  }, undefined, targets.targets.map(target => target.id))
  const skipped = targets.skippedLocked + targets.skippedLinked
  return { ...targets, status: change?.status === 'rejected' ? 'rejected' : change?.status === 'committed' ? 'committed' : 'unchanged', changedNodes, changedReferences, visitedRuns,
    message: change?.status === 'rejected' ? change.message : `已替换 ${changedReferences} 处引用（${changedNodes} 个文字图层）${skipped ? `；跳过 ${targets.skippedLocked} 个锁定、${targets.skippedLinked} 个共享样式图层` : ''}` }
}

/** Match source identities only on authored fields and existing instance overrides. */
export function matchSourceFontsInDocument(doc: DesignDocument, matches: Map<string, { id: string; resource: FontResource }>) {
  const targets = fontTargets(doc, { kind: 'document' })
  let changed = 0
  const install = (match: { id: string; resource: FontResource }) => {
    doc.fonts ??= {}
    const existing = doc.fonts[match.id]
    if (existing && (existing.data !== match.resource.data || (existing.index || 0) !== (match.resource.index || 0))) throw Error('字体标识冲突，原字体已保留')
    doc.fonts[match.id] = match.resource
    changed++
  }
  for (const target of targets.targets) {
    const n = doc.nodes[target.id], source = sourceFonts(doc, n), original = n.textStyle?.fontId ?? 'default'
    if (target.runs) for (const [index, name] of Object.entries(source.runs || {})) {
      const run = n.textRuns?.[Number(index)], match = matches.get(name)
      if (run && match && (run.fontId ?? original) === 'default') { install(match); run.fontId = match.id }
    }
    const match = source.style && matches.get(source.style)
    if (target.style && match && original === 'default') {
      install(match)
      if (n.textStyle) n.textStyle.fontId = match.id
      else n.textStyle = { ...defaultTextStyle(), fontId: match.id }
    }
  }
  return { ...targets, changed }
}
