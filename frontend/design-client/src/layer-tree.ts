import { displayedLayerChildren, layerFlowOrder, usesFigmaLayerFlow } from './layer-order'
import type { DesignDocument, DesignNode } from './model'
import { layerTransition, sameLayerChildren } from './layer-row-transition'

export type LayerExpansion = ReadonlySet<string> | {
  rootFramesOpen: boolean
  overrides: ReadonlyMap<string, boolean>
}

export function layerExpanded(node: DesignNode, depth: number, expansion: LayerExpansion) {
  if ('overrides' in expansion) {
    return expansion.overrides.get(node.id) ?? (expansion.rootFramesOpen && depth === 0 && node.kind === 'frame')
  }
  return !expansion.has(node.id)
}

/** Disclosure expansion stops at hidden branches, which remain individually expandable. */
export function visibleLayerBranch(doc: DesignDocument, root: string): string[] {
  const branches: string[] = [], pending = [root]
  while (pending.length) {
    const id = pending.pop()!, node = doc.nodes[id]
    if (!node?.children.length) continue
    branches.push(id)
    for (const child of node.children) if (doc.nodes[child]?.visible) pending.push(child)
  }
  return branches
}

export function layerTreeRows(doc: DesignDocument, pageId: string, expansion: LayerExpansion, search: string, figmaFlow = usesFigmaLayerFlow(doc)) {
  const query = search.trim().toLocaleLowerCase(), matches = new Set<string>(), included = new Set<string>()
  const roots = doc.pages.find(page => page.id === pageId)?.children || []
  const scan = (id: string, ancestors: string[]) => {
    const n = doc.nodes[id]; if (!n) return
    if (n.name.toLocaleLowerCase().includes(query)) {
      matches.add(id); included.add(id); ancestors.forEach(parent => included.add(parent))
    }
    for (const child of n.children) scan(child, [...ancestors, id])
  }
  if (query) roots.forEach(id => scan(id, []))
  const rows: { id: string; depth: number; context: boolean }[] = []
  const visit = (id: string, depth: number) => {
    const n = doc.nodes[id]; if (!n || (query && !included.has(id))) return
    rows.push({ id, depth, context: !!query && !matches.has(id) })
    if (query || layerExpanded(n, depth, expansion)) displayedLayerChildren(n, n.children, figmaFlow).forEach(child => visit(child, depth + 1))
  }
  displayedLayerChildren(undefined, roots).forEach(id => visit(id, 0))
  return rows
}


/** One panel's current ordering only. Metadata is read from the current document
 * by Layers, never cached in these rows. Structural edits intentionally rebuild:
 * no copied subtree arrays or second whole-document index are maintained.
 * Inputs follow the editor's immutable snapshot/Set contract.
 */
export class LayerRowsCache {
  private previous?: { doc: DesignDocument; page: string; expansion: LayerExpansion; query: string; figmaFlow: boolean; rows: ReturnType<typeof layerTreeRows> }
  readonly stats = { builds: 0, nodeChecks: 0, certificateHits: 0, rowAllocations: 0 }
  clear() { this.previous = undefined }
  read(doc: DesignDocument, page: string, expansion: LayerExpansion, search: string, figmaFlow = usesFigmaLayerFlow(doc)) {
    const query = search.trim().toLocaleLowerCase(), old = this.previous
    let reusable = !!old && old.doc.id === doc.id && old.page === page && old.query === query && old.figmaFlow === figmaFlow &&
      (query !== '' || old.expansion === expansion)
    if (reusable && old && old.doc !== doc) {
      const roots = (d: DesignDocument) => d.pages.find(p => p.id === page)?.children || []
      reusable = sameLayerChildren(roots(old.doc), roots(doc))
      if (reusable && old.doc.nodes !== doc.nodes) {
        const certificate = layerTransition(old.doc, doc)
        if (certificate) {
          this.stats.certificateHits++
          reusable = !certificate.topology && !certificate.flow && (!query || !certificate.names)
        } else {
          // Preview, import, skipped publications, and other uncertified paths
          // must validate all references, not assume a revision implies safety.
          const ids = Object.keys(doc.nodes)
          reusable = ids.length === Object.keys(old.doc.nodes).length
          for (const id of ids) {
            if (!reusable) break
            this.stats.nodeChecks++
            const a = old.doc.nodes[id], b = doc.nodes[id]
            reusable = !!a && (a === b || (sameLayerChildren(a.children, b.children) && layerFlowOrder(a, figmaFlow) === layerFlowOrder(b, figmaFlow) && (!query || a.name === b.name)))
          }
        }
      }
    }
    const rows = reusable && old ? old.rows : layerTreeRows(doc, page, expansion, query, figmaFlow)
    if (!reusable) { this.stats.builds++; this.stats.rowAllocations += rows.length }
    this.previous = { doc, page, expansion, query, figmaFlow, rows }
    return rows
  }
}
