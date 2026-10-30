import { allParents, intersects, type SceneEntry } from './geometry'
import type { Bounds, DesignDocument } from './model'
import { interactivePath, marqueeScope } from './selection-hierarchy'

export type MarqueeSelectionOptions = {
  deep: boolean
  contained: boolean
  additive: boolean
  toggle: boolean
  ignoreId?: string | null
}

/** Use the existing world-space selection AABBs, including the presented
 * snapshot's exact curve bounds. This does not substitute hit halos, raster
 * pixels, clipping, or effect bounds for the editor's picking policy. */
export function canvasMarqueeSelection(document: DesignDocument, page: string,
  origin: readonly string[], entries: readonly SceneEntry[], area: Bounds,
  options: MarqueeSelectionOptions): string[] {
  const parents = allParents(document)
  const scope = marqueeScope(document, page, origin, parents)
  // Forced X starts inside an occupied hierarchy. Removing only its leaf
  // would accidentally promote its container when no other child intersects.
  const ignored = new Set(options.ignoreId ? interactivePath(document, page, options.ignoreId, false, parents) : [])
  const candidates = entries.filter(entry => !ignored.has(entry.id) && !entry.locked &&
    (options.deep || parents.get(entry.id) === scope) &&
    (options.contained
      ? entry.bounds.x >= area.x && entry.bounds.y >= area.y &&
        entry.bounds.x + entry.bounds.width <= area.x + area.width &&
        entry.bounds.y + entry.bounds.height <= area.y + area.height
      : intersects(entry.bounds, area)) &&
    interactivePath(document, page, entry.id, false, parents).length > 0)
  const ancestors = new Set(options.deep ? candidates.flatMap(entry => entry.ancestors) : [])
  const ids = candidates.filter(entry => !ancestors.has(entry.id)).map(entry => entry.id)
  if (options.toggle) {
    const selected = new Set(origin), matches = new Set(ids)
    return [...origin.filter(id => !matches.has(id)), ...ids.filter(id => !selected.has(id))]
  }
  return options.additive ? [...new Set([...origin, ...ids])] : ids
}
