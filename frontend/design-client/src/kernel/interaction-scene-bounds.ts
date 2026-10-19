import type { Bounds, DesignDocument } from '../model'
import { unionBounds, type SceneEntry } from '../geometry'

/** Keep the existing world-space effect/stroke envelope exactly. Grouping
 * changes only membership lookup, never the arithmetic or union order. */
function paddedBounds(document: DesignDocument, entry: SceneEntry): Bounds {
  const node = document.nodes[entry.id]
  const scale = Math.max(Math.hypot(entry.matrix[0], entry.matrix[1]), Math.hypot(entry.matrix[2], entry.matrix[3]))
  const pad = Math.max(0, ...node.effects.filter(effect => effect.visible).map(effect =>
    effect.radius * 3 + Math.abs(effect.x || 0) + Math.abs(effect.y || 0) + Math.abs(effect.spread || 0)),
  ...node.strokes.filter(stroke => stroke.visible).map(stroke => stroke.width * 4)) * scale
  return { x: entry.bounds.x - pad, y: entry.bounds.y - pad,
    width: entry.bounds.width + pad * 2, height: entry.bounds.height + pad * 2 }
}

/** Collect each page root's existing scene envelope in one traversal rather
 * than filtering the whole scene once per root. Do not cache across documents
 * or pages: edits, derived group bounds and visibility are already reflected
 * in the supplied scene. Empty/hidden roots retain the original zero bounds.
 * A scene entry can belong to both an explicit root and an ancestor root;
 * retain that behavior without adding the same entry twice to one union. */
export function interactionRootBounds(document: DesignDocument, pageId: string, entries: readonly SceneEntry[]): Map<string, Bounds> {
  const groups = new Map((document.pages.find(page => page.id === pageId)?.children || [])
    .map(id => [id, [] as Bounds[]]))
  for (const entry of entries) {
    const direct = groups.get(entry.id), ancestor = groups.get(entry.ancestors[0])
    if (!direct && !ancestor) continue
    const bounds = paddedBounds(document, entry)
    direct?.push(bounds)
    if (ancestor && ancestor !== direct) ancestor.push(bounds)
  }
  return new Map([...groups].map(([id, bounds]) => [id, unionBounds(bounds)]))
}
