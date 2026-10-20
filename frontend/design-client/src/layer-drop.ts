import { allParents, type ParentMap } from './geometry'
import { container, type DesignDocument } from './model'

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

/** Rows run front-to-back while children are stored back-to-front. */
export function layerDropPlan(doc: DesignDocument, page: string, dragged: readonly string[], target: string | null,
  position: LayerDropPosition, parents?: ParentMap): { parent: string; before?: string } | undefined {
  if (!dragged.length) return
  parents ??= allParents(doc)
  const selected = new Set(dragged)
  if (target && (!doc.nodes[target] || selected.has(target))) return
  const parent = target ? position === 'inside' ? target : parents.get(target) : page
  if (!parent || (doc.nodes[parent] ? !container(doc.nodes[parent]) : parent !== page)) return
  for (let id: string | undefined = parent; id; id = parents.get(id))
    if (selected.has(id) || doc.nodes[id]?.locked) return
  const siblings = (doc.nodes[parent]?.children || doc.pages.find(p => p.id === parent)?.children || []).filter(id => !selected.has(id))
  if (!target) return { parent, before: siblings[0] }
  if (position === 'inside') return { parent }
  const at = siblings.indexOf(target)
  if (at < 0) return
  return { parent, before: position === 'below' ? target : siblings[at + 1] }
}
