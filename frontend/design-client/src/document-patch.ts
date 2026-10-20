import { certifyLayerTransition } from './layer-row-transition'
import type { DesignDocument, DesignNode } from './model'
export type DocumentPatch = {
  nodes: Record<string, DesignNode | null>
  fields: Record<string, unknown>
}
export type EditResult = {
  /** The shape-faithful authored document. Never reconstruct it from Rust's
   * normalized graph nodes or from this transport-compatible patch. */
  document: DesignDocument
  revision: number
  patch: DocumentPatch
  /** Includes inserted, changed and removed authored nodes; excludes pseudo pages. */
  changedIds: string[]
  undoDepth: number
  redoDepth: number
}
export function equalValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (
    !a ||
    !b ||
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    Array.isArray(a) !== Array.isArray(b)
  )
    return false
  const x = Object.keys(a),
    y = Object.keys(b)
  return (
    x.length === y.length &&
    x.every(
      (key) =>
        Object.hasOwn(b, key) &&
        equalValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  )
}
/** Reuse unchanged immutable records instead of retaining 80 complete clones. */
export function shareDocument(before: DesignDocument, candidate: DesignDocument): DesignDocument {
  const nodes: Record<string, DesignNode> = {}
  let changed = Object.keys(before.nodes).length !== Object.keys(candidate.nodes).length
  for (const [id, n] of Object.entries(candidate.nodes)) {
    const same = equalValue(before.nodes[id], n)
    nodes[id] = same ? before.nodes[id] : n
    changed ||= !same
  }
  const result = { ...candidate, nodes: changed ? nodes : before.nodes }
  for (const key of Object.keys(candidate) as (keyof DesignDocument)[])
    if (key !== 'nodes' && equalValue(before[key], candidate[key]))
      Object.assign(result, { [key]: before[key] })
  return equalValue(before, result) ? before : result
}
export function documentPatch(before: DesignDocument, after: DesignDocument): DocumentPatch {
  if (before.id !== after.id) throw new Error('编辑操作不能改变文件标识')
  const nodes: DocumentPatch['nodes'] = {},
    fields: DocumentPatch['fields'] = {}
  for (const [id, n] of Object.entries(after.nodes)) if (n !== before.nodes[id]) nodes[id] = n
  for (const id of Object.keys(before.nodes)) if (!after.nodes[id]) nodes[id] = null
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)]))
    if (
      key !== 'nodes' &&
      key !== 'id' &&
      (before as unknown as Record<string, unknown>)[key] !==
        (after as unknown as Record<string, unknown>)[key]
    )
      fields[key] = (after as unknown as Record<string, unknown>)[key] ?? null
  certifyLayerTransition(before, after, nodes)
  return { nodes, fields }
}
/** Normalise a kernel-round-tripped node: drop explicit null optionals. */
export function nodeFromKernel(n: DesignNode): DesignNode {
  for (const key of [
    'network',
    'layout',
    'sizing',
    'constraints',
    'component',
    'instance',
    'instanceOrigin',
    'componentKey',
    'textStyle',
  ] as const)
    if (n[key] === null) delete n[key]
  for (const paint of [...n.fills, ...n.strokes.map((s) => s.paint)])
    if (paint.image === null) delete paint.image
  return n
}
export function applyDocumentPatch(doc: DesignDocument, patch: DocumentPatch): DesignDocument {
  const next = { ...doc, nodes: { ...doc.nodes } }
  for (const [key, value] of Object.entries(patch.fields)) {
    if (value === null) delete (next as unknown as Record<string, unknown>)[key]
    else Object.assign(next, { [key]: value })
  }
  for (const [id, node] of Object.entries(patch.nodes)) {
    if (node) next.nodes[id] = nodeFromKernel(node)
    else delete next.nodes[id]
  }
  return next
}
