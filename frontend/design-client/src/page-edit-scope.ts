import { documentTransition, peekChangedNodes } from './document-patch'
import type { DesignDocument, DesignNode } from './model'

/** A committed edit whose node changes stay on one page and do not retarget
 * cross-page component, connector, or instance dependencies. */
export type PageEditScope = {
  pageId: string
  ids: readonly string[]
  /** Ancestor or descendant geometry still needs the layout kernel. */
  layout: boolean
}

type EditIndex = { parents: Map<string, string>; externalRefs: Set<string>; pageChildren: readonly string[][] }
const indexes = new WeakMap<DesignDocument, EditIndex>()

function pageChildrenMatch(doc: DesignDocument, index: EditIndex) {
  return doc.pages.length === index.pageChildren.length && doc.pages.every((page, i) => page.children === index.pageChildren[i])
}

function buildIndex(doc: DesignDocument): EditIndex {
  const parents = new Map<string, string>()
  const externalRefs = new Set<string>()
  for (const page of doc.pages) for (const id of page.children) parents.set(id, page.id)
  for (const n of Object.values(doc.nodes)) {
    for (const child of n.children) parents.set(child, n.id)
    if (n.connector?.from.nodeId) externalRefs.add(n.connector.from.nodeId)
    if (n.connector?.to.nodeId) externalRefs.add(n.connector.to.nodeId)
    if (n.instance) {
      externalRefs.add(n.instance.componentId)
      for (const list of Object.values(n.instance.slotContents || {})) for (const id of list) externalRefs.add(id)
    }
    if (n.instanceOrigin) externalRefs.add(n.instanceOrigin.owner)
  }
  return { parents, externalRefs, pageChildren: doc.pages.map(page => page.children) }
}

/** Immutable snapshots share one parent/reference index. Drafts are not cached. */
function editIndex(doc: DesignDocument) {
  const cached = indexes.get(doc)
  if (cached && pageChildrenMatch(doc, cached)) return cached
  let cursor = doc
  for (let hop = 0; hop < 32; hop++) {
    const link = documentTransition(cursor)
    if (!link || link.structural || link.references) break
    const inherited = indexes.get(link.before)
    if (inherited && pageChildrenMatch(doc, inherited)) { indexes.set(doc, inherited); return inherited }
    cursor = link.before
  }
  const built = buildIndex(doc)
  indexes.set(doc, built)
  return built
}

/** Parent of a node in an immutable snapshot. Used by the op compiler. */
export function snapshotParent(doc: DesignDocument, id: string): string | undefined {
  return editIndex(doc).parents.get(id)
}
/** Shared parent links for an immutable snapshot. Callers must not mutate the map. */
export function snapshotParents(doc: DesignDocument): ReadonlyMap<string, string> {
  return editIndex(doc).parents
}
/** True when a connector, instance, or slot on any page names one of these nodes. */
export function snapshotTargets(doc: DesignDocument, ids: readonly string[]): boolean {
  const refs = editIndex(doc).externalRefs
  return ids.some(id => refs.has(id))
}

function crossNode(n: DesignNode | undefined): boolean {
  return !!n && !!(n.component || n.componentSet || n.componentKey != null || n.instance || n.instanceOrigin ||
    n.booleanOperation || n.connector || n.repeat || n.textPath ||
    (n.board?.kind === 'code-block' && n.board.language) ||
    Object.keys(n.bindings || {}).length || Object.keys(n.styleRefs || {}).length ||
    Object.keys(n.variableModes || {}).length)
}

function needsLayout(n: DesignNode): boolean {
  return !!(n.constraints || (n.layout && n.layout.mode !== 'none') ||
    (n.sizing && (n.sizing.width !== 'fixed' || n.sizing.height !== 'fixed')))
}

const geometryKeys = ['kind', 'width', 'height', 'transform', 'children', 'text', 'fontSize', 'textStyle', 'textRuns', 'layout', 'sizing', 'constraints', 'visible', 'network', 'vectorGeometry'] as const

function geometryChange(before: DesignNode, after: DesignNode): boolean {
  return geometryKeys.some(key => before[key] !== after[key])
}

function subtree(doc: DesignDocument, id: string, visit: (n: DesignNode) => boolean): boolean {
  const seen = new Set<string>()
  const walk = (current: string): boolean => {
    if (seen.has(current)) return false
    seen.add(current)
    const n = doc.nodes[current]
    if (!n) return false
    if (visit(n)) return true
    return n.children.some(walk)
  }
  return walk(id)
}

function pageOf(doc: DesignDocument, id: string, parents: Map<string, string>, pages: Set<string>): string | undefined {
  let at: string | undefined = id
  const seen = new Set<string>()
  while (at && !seen.has(at)) {
    seen.add(at)
    const parent = parents.get(at)
    if (!parent) return pages.has(at) ? at : undefined
    if (pages.has(parent)) return parent
    at = parent
  }
}

function coldPagesFrozen(before: DesignDocument, after: DesignDocument): boolean {
  if (before.pages === after.pages) return true
  if (before.pages.length !== after.pages.length) return false
  let changed = 0
  for (let i = 0; i < before.pages.length; i++) {
    const left = before.pages[i], right = after.pages[i]
    if (left === right) continue
    changed++
    if (changed > 1 || left.id !== right.id || left.children.length !== right.children.length ||
      left.children.some((id, index) => id !== right.children[index])) return false
  }
  return true
}

/** Feature checks for a page-scoped edit. Cold nodes stay on the admitted schema. */
export function documentForSchema(doc: DesignDocument, ids: readonly string[]): DesignDocument {
  const nodes: DesignDocument['nodes'] = {}
  for (const id of ids) if (doc.nodes[id]) nodes[id] = doc.nodes[id]
  return { ...doc, nodes }
}

function scopeFrom(before: DesignDocument, after: DesignDocument, ids: readonly string[], forceLayout: boolean | undefined): PageEditScope | undefined {
  if (!ids.length || ids.length > 4096) return
  if (before.animations?.length || after.animations?.length) return
  const index = editIndex(before)
  const pages = new Set(before.pages.map(page => page.id))
  let pageId: string | undefined
  let layout = false
  for (const id of ids) {
    const old = before.nodes[id], next = after.nodes[id]
    if (!old || !next) return
    if (old.children.length !== next.children.length || old.children.some((child, index) => child !== next.children[index])) return
    if (crossNode(old) || crossNode(next)) return
    let at = index.parents.get(id)
    const seen = new Set<string>([id])
    while (at && after.nodes[at] && !seen.has(at)) {
      seen.add(at)
      if (crossNode(after.nodes[at])) return
      at = index.parents.get(at)
    }
    const page = pageOf(after, id, index.parents, pages)
    if (!page) return
    if (!pageId) pageId = page
    else if (pageId !== page) return
    const geometry = forceLayout ?? geometryChange(old, next)
    if (geometry) {
      if (subtree(after, id, crossNode)) return
      if (index.externalRefs.size && subtree(after, id, n => index.externalRefs.has(n.id))) return
      if (subtree(after, id, needsLayout)) layout = true
      else {
        let parent = index.parents.get(id)
        const visited = new Set<string>()
        while (parent && after.nodes[parent] && !visited.has(parent)) {
          visited.add(parent)
          if (needsLayout(after.nodes[parent])) { layout = true; break }
          parent = index.parents.get(parent)
        }
      }
    } else if (index.externalRefs.has(id)) return
  }
  if (!pageId) return
  const changedPage = before.pages === after.pages ? undefined : after.pages.find((page, index) => page !== before.pages[index])?.id
  if (changedPage && changedPage !== pageId) return
  return { pageId, ids, layout: forceLayout === false ? false : layout }
}

/** Local proofs are already confined to scalar fields. This only names their page. */
export function singlePageScope(doc: DesignDocument, ids: readonly string[]): PageEditScope | undefined {
  return scopeFrom(doc, doc, ids, false)
}

function rootFieldsChanged(before: DesignDocument, after: DesignDocument): boolean {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const key of keys) {
    if (key === 'nodes' || key === 'id' || key === 'pages') continue
    if ((before as unknown as Record<string, unknown>)[key] !== (after as unknown as Record<string, unknown>)[key]) return true
  }
  return false
}
export function pageEditScope(before: DesignDocument, after: DesignDocument): PageEditScope | undefined {
  if (before === after || before.id !== after.id) return
  // Read-only. documentPatch would record a witness before later normalization
  // and hide those nodes from the component resolver.
  if (rootFieldsChanged(before, after)) return
  if (!coldPagesFrozen(before, after)) return
  const changed = peekChangedNodes(before, after)
  const ids = Object.keys(changed)
  for (const id of ids) if (!changed[id]) return
  return scopeFrom(before, after, ids, undefined)
}
