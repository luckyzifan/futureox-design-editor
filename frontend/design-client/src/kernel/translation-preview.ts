import type { ConstraintAnchor, DesignDocument, DesignNode } from '../model'

const hasReferences = (node: DesignNode) =>
  !!(node.component || node.componentSet || node.componentKey != null || node.instance ||
    node.instanceOrigin || node.booleanOperation || Object.keys(node.bindings || {}).length ||
    Object.keys(node.styleRefs || {}).length || Object.keys(node.variableModes || {}).length)

const anchors: readonly ConstraintAnchor[] = ['start', 'center', 'end', 'stretch', 'scale']
function constrainedAxis(position: number, size: number, old: number, next: number, mode: ConstraintAnchor): readonly [number, number] {
  // Preserve layout.rs::anchor's operation order, including End cancellation
  // and Stretch/Scale's minimum. Equal reference extents alone are insufficient.
  switch (mode) {
    case 'start': return [position, size]
    case 'center': return [position + (next - old) / 2, size]
    case 'end': return [position + next - old, size]
    case 'stretch': return [position, Math.max(size + next - old, 0.01)]
    case 'scale': return [position * (next / old), Math.max(size * (next / old), 0.01)]
  }
}
function fixedConstraints(node: DesignNode, parent: DesignNode | undefined, pageRoot: boolean): boolean {
  const c = node.constraints
  if (!c) return true
  if (!anchors.includes(c.horizontal) || !anchors.includes(c.vertical)) return false
  for (const reference of [c.referenceWidth, c.referenceHeight])
    if (reference != null && (!Number.isFinite(reference) || reference < 0.01 || reference > 1e7)) return false
  // Rust constrains a node's children, not page roots. Do not confuse a known
  // root with an orphan; root reference fields remain untouched by that solver.
  if (!parent) return pageRoot
  if (typeof c.referenceWidth !== 'number' || typeof c.referenceHeight !== 'number' ||
      !Object.is(c.referenceWidth, parent.width) || !Object.is(c.referenceHeight, parent.height)) return false
  const x = node.transform[4], y = node.transform[5]
  if ([x, y, node.width, node.height].some(value => !Number.isFinite(value) || Object.is(value, -0))) return false
  const [nx, width] = constrainedAxis(x, node.width, c.referenceWidth, parent.width, c.horizontal)
  const [ny, height] = constrainedAxis(y, node.height, c.referenceHeight, parent.height, c.vertical)
  return Object.is(nx, x) && Object.is(ny, y) && Object.is(width, node.width) && Object.is(height, node.height)
}

/** A placement-only preview over an already resolved immutable document.
 * Returns null whenever layout or another node's derived geometry may depend
 * on the change. Opaque format metadata can remain in the same design system.
 */
export function translationOnlyChanges(previous: DesignDocument, next: DesignDocument): string[] | null {
  const previousFields = Object.keys(previous)
  if (previousFields.length !== Object.keys(next).length || previousFields.some(key =>
    !Object.hasOwn(next, key) ||
    (key !== 'nodes' && previous[key as keyof DesignDocument] !== next[key as keyof DesignDocument]))) return null
  if (next.animations?.length) return null
  const ids = Object.keys(next.nodes)
  if (ids.length !== Object.keys(previous.nodes).length || ids.some(id => !previous.nodes[id])) return null
  const changed: string[] = []
  const parents = new Map<string, string>()
  const pageRoots = new Set(next.pages.flatMap(page => page.children))
  for (const id of ids) {
    const node = next.nodes[id], before = previous.nodes[id]
    if (node.connector || (node.board?.kind === 'code-block' && node.board.language)) return null
    for (const child of node.children) {
      if (!next.nodes[child] || parents.has(child)) return null
      parents.set(child, id)
    }
    if (node === before) continue
    const fields = Object.keys(before)
    if (fields.length !== Object.keys(node).length || fields.some(key =>
      !Object.hasOwn(node, key) ||
      (key !== 'transform' && before[key as keyof DesignNode] !== node[key as keyof DesignNode]))) return null
    if (node.transform.length !== 6 || node.transform.some(value => !Number.isFinite(value) || Math.abs(value) > 1e7) ||
      node.transform.slice(0, 4).some((value, index) => !Object.is(value, before.transform[index]))) return null
    changed.push(id)
  }
  for (const id of changed) {
    const seen = new Set<string>()
    let at: string | undefined = id
    while (at) {
      if (seen.has(at)) return null
      seen.add(at)
      const node: DesignNode | undefined = next.nodes[at]
      const parentId = parents.get(at)
      if (!node || hasReferences(node) || !fixedConstraints(node, parentId ? next.nodes[parentId] : undefined, pageRoots.has(at)) ||
        (node.layout && node.layout.mode !== 'none') ||
        (node.sizing && (node.sizing.width !== 'fixed' || node.sizing.height !== 'fixed'))) return null
      at = parentId
    }
  }
  return changed
}
