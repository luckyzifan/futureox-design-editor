import type { DesignDocument, DesignNode } from '../model'

const hasReferences = (node: DesignNode) =>
  !!(node.component || node.componentSet || node.componentKey != null || node.instance ||
    node.instanceOrigin || node.booleanOperation || Object.keys(node.bindings || {}).length ||
    Object.keys(node.styleRefs || {}).length || Object.keys(node.variableModes || {}).length)

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
      if (!node || hasReferences(node) || node.constraints ||
        (node.layout && node.layout.mode !== 'none') ||
        (node.sizing && (node.sizing.width !== 'fixed' || node.sizing.height !== 'fixed'))) return null
      at = parents.get(at)
    }
  }
  return changed
}
