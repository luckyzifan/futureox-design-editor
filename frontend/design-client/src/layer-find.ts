import type { Editor } from './engine'
import type { DesignDocument, DesignNode } from './model'
import { displayedLayerChildren } from './layer-order'

/** Find classifications. Empty `types` means every classification. */
export const layerFindTypes = ['text', 'frame', 'group', 'component', 'instance', 'shape', 'image', 'section', 'other'] as const
export type LayerFindType = (typeof layerFindTypes)[number]
export type LayerFindScope = 'page' | 'file'
export type LayerFindResult = {
  id: string
  pageId: string
  pageName: string
  name: string
  type: LayerFindType
}
export type LayerFindOptions = {
  query: string
  scope: LayerFindScope
  pageId: string
  matchCase: boolean
  wholeWords: boolean
  /** Empty includes every type. A non-empty set keeps only those classifications. */
  types: ReadonlySet<LayerFindType>
}

const shapeKinds = new Set<DesignNode['kind']>(['rectangle', 'ellipse', 'polygon', 'star', 'line', 'vector'])

/** Instance and component win over the underlying frame or shape, matching the layer's role. */
export function layerFindType(node: DesignNode): LayerFindType {
  if (node.instance) return 'instance'
  if (node.component || node.componentSet) return 'component'
  if (node.kind === 'text') return 'text'
  if (node.kind === 'group') return 'group'
  if (node.kind === 'section') return 'section'
  if (node.kind === 'frame') return 'frame'
  if (node.kind === 'slice') return 'other'
  if (shapeKinds.has(node.kind) && node.fills.some(fill => fill.visible && fill.kind === 'image')) return 'image'
  if (shapeKinds.has(node.kind)) return 'shape'
  return 'other'
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function matcher(query: string, matchCase: boolean, wholeWords: boolean): ((value: string) => boolean) | null {
  const needle = matchCase ? query : query.toLocaleLowerCase()
  if (!needle) return null
  if (!wholeWords) {
    return value => (matchCase ? value : value.toLocaleLowerCase()).includes(needle)
  }
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(needle)}(?![\\p{L}\\p{N}_])`, 'u')
  return value => pattern.test(matchCase ? value : value.toLocaleLowerCase())
}

function nodeMatches(node: DesignNode, match: (value: string) => boolean) {
  if (match(node.name)) return true
  // Only text layers have searchable copy. Other kinds keep a placeholder string.
  return node.kind === 'text' && !!node.text && match(node.text)
}

/**
 * Results follow the layers panel: pages in document order, and within a page
 * the displayed child order, parent before descendants. Only the current page
 * is scanned for scope `page`. Hidden and locked layers are included. The
 * document is not copied.
 */
export function layerFindResults(doc: DesignDocument, options: LayerFindOptions): LayerFindResult[] {
  const query = options.query.trim()
  const match = matcher(query, options.matchCase, options.wholeWords)
  if (!match) return []
  const pages = options.scope === 'page'
    ? doc.pages.filter(page => page.id === options.pageId)
    : doc.pages
  const results: LayerFindResult[] = []
  for (const page of pages) {
    const frames: { ids: readonly string[]; index: number }[] = [{ ids: displayedLayerChildren(undefined, page.children), index: 0 }]
    while (frames.length) {
      const frame = frames[frames.length - 1]
      if (frame.index >= frame.ids.length) { frames.pop(); continue }
      const id = frame.ids[frame.index]
      frame.index += 1
      const node = doc.nodes[id]
      if (!node) continue
      const type = layerFindType(node)
      if (nodeMatches(node, match) && (options.types.size === 0 || options.types.has(type))) {
        results.push({ id, pageId: page.id, pageName: page.name, name: node.name, type })
      }
      if (node.children.length) frames.push({ ids: displayedLayerChildren(node, node.children, true), index: 0 })
    }
  }
  return results
}

function resultOnPage(doc: DesignDocument, result: LayerFindResult) {
  const page = doc.pages.find(item => item.id === result.pageId)
  if (!page || !doc.nodes[result.id]) return false
  const stack = [...page.children]
  const seen = new Set<string>()
  while (stack.length) {
    const id = stack.pop()!
    if (id === result.id) return true
    if (seen.has(id)) continue
    seen.add(id)
    const node = doc.nodes[id]
    if (node) for (const child of node.children) stack.push(child)
  }
  return false
}

/**
 * Select the result and, when it lives on another page, show that page.
 * Publishes a reveal request. Does not call `change`, so it adds no history
 * of its own. Returns false when the editor is busy, the node is gone, or a
 * pending edit commit advanced the document while navigating.
 */
export function locateLayerFindResult(editor: Editor, result: LayerFindResult): boolean {
  if (editor.state.busy || editor.interactionActive) return false
  const before = editor.state.doc
  const version = editor.state.version
  const undo = editor.canUndo
  if (!resultOnPage(before, result)) return false
  if (editor.state.page !== result.pageId) {
    editor.set({ page: result.pageId, selection: [result.id], editingVertex: null, editingVertices: [] })
  } else if (editor.state.selection.length !== 1 || editor.state.selection[0] !== result.id) {
    editor.select([result.id])
  }
  if (editor.state.doc !== before || editor.state.version !== version || editor.canUndo !== undo) return false
  if (editor.state.page !== result.pageId || !editor.state.selection.includes(result.id)) return false
  editor.requestReveal([result.id])
  return editor.state.doc === before && editor.state.version === version && editor.canUndo === undo
    && editor.revealSnapshot()?.pageId === result.pageId
    && editor.revealSnapshot()?.ids.includes(result.id) === true
}

/** Next is direction 1, previous is -1. No current hit starts at the corresponding end. */
export function adjacentLayerFindResult(results: readonly LayerFindResult[], selected: { id: string; pageId: string } | null, direction: 1 | -1): LayerFindResult | null {
  if (!results.length) return null
  const index = selected ? results.findIndex(result => result.id === selected.id && result.pageId === selected.pageId) : -1
  if (index < 0) return direction > 0 ? results[0] : results[results.length - 1]
  const next = index + direction
  if (next < 0 || next >= results.length) return null
  return results[next]
}
