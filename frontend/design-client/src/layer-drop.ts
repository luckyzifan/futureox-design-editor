import { allParents, type ParentMap } from './geometry'
import { layerFlowOrder, usesFigmaLayerFlow } from './layer-order'
import { container, type DesignDocument } from './model'
import { assertStructuralParent, indexSelection, SelectionCommandError } from './commands/selection-command'

export type LayerDropPosition = 'above' | 'inside' | 'below'

/** Selection order is click order; hierarchy moves must preserve painter order. */
export function orderedLayerRoots(doc: DesignDocument, page: string, selected: readonly string[]) {
  const ids = new Set(selected), result: string[] = []
  const visit = (id: string) => {
    if (ids.has(id)) result.push(id)
    for (const child of doc.nodes[id]?.children || []) visit(child)
  }
  doc.pages.find(p => p.id === page)?.children.forEach(visit)
  return result
}

export function layerDropPosition(isContainer: boolean, fraction: number): LayerDropPosition {
  return isContainer && fraction >= .25 && fraction <= .75 ? 'inside' : fraction < .5 ? 'above' : 'below'
}

/** Validate the explicit selection before dropping any locked or derived
 * member. Move the whole selection, or leave it unmodified. */
export function pageMoveRoots(doc: DesignDocument, page: string, selected: readonly string[], parents: ParentMap, ordered = false) {
  try {
    const index = indexSelection(doc, selected, ordered, parents)
    if (index.pageId !== page || !index.ids.length) return
    for (const id of new Set(selected)) {
      if (doc.nodes[id].instanceOrigin) return
      assertStructuralParent(doc, parents.get(id)!, parents)
    }
    return index.ids
  } catch (error) {
    if (!(error instanceof SelectionCommandError)) throw error
    return
  }
}

/** Freeform rows run front-to-back. Auto-layout rows run in flow order.
 * `before` is the storage sibling the drop is inserted ahead of. */
export function layerDropPlan(doc: DesignDocument, page: string, dragged: readonly string[], target: string | null,
  position: LayerDropPosition, parents?: ParentMap, figmaFlow = usesFigmaLayerFlow(doc)): { parent: string; before?: string } | undefined {
  if (!dragged.length) return
  parents ??= allParents(doc)
  const selected = new Set(dragged)
  if (target && (!doc.nodes[target] || selected.has(target))) return
  const parent = target ? position === 'inside' ? target : parents.get(target) : page
  if (!parent || (doc.nodes[parent] ? !container(doc.nodes[parent]) : parent !== page)) return
  for (let id: string | undefined = parent; id; id = parents.get(id))
    if (selected.has(id) || doc.nodes[id]?.locked) return
  const siblings = (doc.nodes[parent]?.children || doc.pages.find(p => p.id === parent)?.children || []).filter(id => !selected.has(id))
  const flow = layerFlowOrder(doc.nodes[parent], figmaFlow)
  if (!target) return { parent, before: flow ? undefined : siblings[0] }
  if (position === 'inside') return { parent }
  const at = siblings.indexOf(target)
  if (at < 0) return
  const next = siblings[at + 1]
  return { parent, before: position === 'above' ? (flow ? target : next) : (flow ? next : target) }
}
