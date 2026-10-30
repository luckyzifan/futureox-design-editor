import type { DesignDocument } from '../model'

const filteredEffects = new Set(['blur', 'background-blur', 'shadow', 'inner-shadow', 'glass'])

/** Only reachable, visible page content can require the conservative filter
 * density policy. Hidden branches, other pages and detached definitions must
 * not turn every camera sample into a new exact-density raster plan.
 *
 * Keep offscreen effects conservative: authored geometry bounds do not include
 * their filter support, shadows or ancestor compositions. Excluding those from
 * a viewport requires a kernel-certified paint bound, not a raw node rectangle.
 * This changes scheduling eligibility only, never pixel density or effects. */
export function pageHasFilteredContent(
  document: Pick<DesignDocument, 'nodes' | 'pages'>,
  pageId: string,
): boolean {
  const pending = [...(document.pages.find(page => page.id === pageId)?.children || [])]
  const visited = new Set<string>()
  while (pending.length) {
    const id = pending.pop()!
    if (visited.has(id)) continue
    visited.add(id)
    const node = document.nodes[id]
    if (!node?.visible) continue
    // Authored instances/styles can acquire effects only during kernel
    // resolution. Without a resolved paint proof keep their exact policy,
    // even when an instance has no authored children of its own.
    if (node.instance || Object.keys(node.styleRefs || {}).length > 0) return true
    if (node.effects.some(effect => effect.visible && filteredEffects.has(effect.kind))) return true
    for (const child of node.children) pending.push(child)
  }
  return false
}
