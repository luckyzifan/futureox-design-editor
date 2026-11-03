import { produceDraftWithPatches } from './draft'
import { certifyLayerTransition } from './layer-row-transition'
import { validNodeTransform, type DesignDocument, type DesignNode } from './model'
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
  if (before === candidate) return before
  const witnessed = witnessedIds(before, candidate)
  let nodes = candidate.nodes, changed = false
  if (witnessed) {
    // A complete producer/applied-patch witness proves that all other records
    // are unchanged. Never accept caller selection/draft IDs as that proof.
    for (const id of witnessed) {
      const same = equalValue(before.nodes[id], candidate.nodes[id])
      if (same && candidate.nodes[id] !== before.nodes[id]) {
        if (nodes === candidate.nodes) nodes = { ...nodes }
        if (before.nodes[id]) nodes[id] = before.nodes[id]
        else delete nodes[id]
      }
      changed ||= !same
    }
  } else {
    changed = Object.keys(before.nodes).length !== Object.keys(candidate.nodes).length
    for (const [id, n] of Object.entries(candidate.nodes)) {
      const same = equalValue(before.nodes[id], n)
      if(same&&n!==before.nodes[id]){
        if(nodes===candidate.nodes)nodes={...nodes}
        nodes[id]=before.nodes[id]
      }
      changed ||= !same
    }
  }
  if (!changed) nodes = before.nodes
  let result = nodes === candidate.nodes ? candidate : { ...candidate, nodes }
  for (const key of Object.keys(candidate) as (keyof DesignDocument)[])
    if (key !== 'nodes' && candidate[key] !== before[key] && equalValue(before[key], candidate[key])) {
      if (result === candidate) result = { ...candidate, nodes }
      Object.assign(result, { [key]: before[key] })
    }
  // Do not recursively compare every node again after the complete node diff.
  const keys = Object.keys(before) as (keyof DesignDocument)[]
  if (!changed && keys.length === Object.keys(result).length && keys.every(key =>
    Object.hasOwn(result, key) && before[key] === result[key])) return before
  if (witnessed) rememberTransition(before, result, [...witnessed])
  return result
}
// Contract: published documents and their node records are immutable. This is
// the same identity contract used by the client lane revision snapshots.
// Only complete, computed diffs and applied patches create witnesses. Caller
// hints (selection/draft IDs) are deliberately not accepted. Weak references
// retain neither old documents nor resource payloads; traversal and metadata
// are bounded, with an unconditional full-diff fallback when proof is absent.
const MAX_TRANSITION_IDS = 4096
const MAX_TRANSITION_HOPS = 32
const documentTransitions = new WeakMap<DesignDocument, {
  before: WeakRef<DesignDocument>; ids: readonly string[]
}>()
function rememberTransition(before: DesignDocument, after: DesignDocument, ids: string[]) {
  if (before !== after && ids.length <= MAX_TRANSITION_IDS)
    documentTransitions.set(after, { before: new WeakRef(before), ids })
}
function witnessedIds(before: DesignDocument, after: DesignDocument): Set<string> | undefined {
  let cursor = after
  const ids = new Set<string>()
  for (let hop = 0; hop < MAX_TRANSITION_HOPS; hop++) {
    const transition = documentTransitions.get(cursor)
    const previous = transition?.before.deref()
    if (!transition || !previous) return
    for (const id of transition.ids) ids.add(id)
    if (ids.size > MAX_TRANSITION_IDS) return
    if (previous === before) return ids
    cursor = previous
  }
}
/** Read only the existing complete producer witness. No caller-supplied IDs
 * can establish this proof; unknown snapshots must retain their full scan. */
export function documentTransitionNodeIds(before: DesignDocument, after: DesignDocument): ReadonlySet<string> | undefined {
  return witnessedIds(before, after)
}
/** The producer itself computes the complete changed-node witness. Whole
 * root/node-map replacement falls back to the ordinary full diff. The witness
 * is process-local acceleration only; documentPatch remains serializable. */
export function produceDocumentDraft(before: DesignDocument, recipe: (draft: DesignDocument) => void): DesignDocument {
  const [after, patches] = produceDraftWithPatches(before, recipe)
  const ids = new Set<string>()
  let complete = true
  for (const patch of patches) {
    if (!patch.path.length || (patch.path[0] === 'nodes' && patch.path.length < 2)) { complete = false; break }
    if (patch.path[0] === 'nodes') ids.add(String(patch.path[1]))
  }
  if (complete) rememberTransition(before, after, [...ids])
  return after
}
/** Publish absolute poses with a complete changed-node witness. Copy the
 * node table once, and own the six numbers supplied by each gesture. */
export function producePoseDocument(before: DesignDocument, patches: Readonly<Record<string, Partial<DesignNode>>>) {
  const ids = Object.keys(patches)
  if (!ids.length || ids.length > 16) return
  let nodes = before.nodes
  const changed: string[] = []
  for (const id of ids) {
    const patch = patches[id], input = patch.transform
    if (!Object.hasOwn(before.nodes, id) || Object.keys(patch).length !== 1 ||
        !Object.hasOwn(patch, 'transform') || !Array.isArray(input) || input.length !== 6) return
    const transform = Array.from({ length: 6 }, (_, i) => Object.getOwnPropertyDescriptor(input, i)?.value)
    if (!validNodeTransform(transform)) return
    const previous = before.nodes[id]
    if (previous.transform.every((value,i) => Object.is(value, transform[i]))) continue
    if (nodes === before.nodes) nodes = { ...before.nodes }
    nodes[id] = { ...previous, transform }
    changed.push(id)
  }
  if (nodes === before.nodes) return before
  const after = { ...before, nodes }
  rememberTransition(before, after, changed)
  return after
}

export function documentPatch(before: DesignDocument, after: DesignDocument): DocumentPatch {
  if (before.id !== after.id) throw new Error('编辑操作不能改变文件标识')
  const nodes: DocumentPatch['nodes'] = {},
    fields: DocumentPatch['fields'] = {}
  const ids = before.nodes === after.nodes ? new Set<string>() : witnessedIds(before, after)
  if (ids) {
    for (const id of ids)
      if (after.nodes[id] !== before.nodes[id]) nodes[id] = after.nodes[id] ?? null
  } else {
    for (const [id, n] of Object.entries(after.nodes)) if (n !== before.nodes[id]) nodes[id] = n
    for (const id of Object.keys(before.nodes)) if (!after.nodes[id]) nodes[id] = null
    rememberTransition(before, after, Object.keys(nodes))
  }
  // Root fields are small, and include resources, pages and optional extensions.
  // Always inspect them rather than relying on an incomplete edit-field hint.
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
  // Transport records can also be shared authored snapshots. Normalize by
  // copy-on-write, never delete properties from the patch or an older snapshot.
  let result = n
  for (const key of [
    'network',
    'vectorGeometry',
    'layout',
    'sizing',
    'constraints',
    'component',
    'instance',
    'instanceOrigin',
    'componentKey',
    'textStyle',
  ] as const)
    if (n[key] === null) {
      if (result === n) result = { ...n }
      delete result[key]
    }
  if (n.fills.some(paint => paint.image === null)) {
    if (result === n) result = { ...n }
    result.fills = n.fills.map(paint => {
      if (paint.image !== null) return paint
      const copy = { ...paint }; delete copy.image; return copy
    })
  }
  if (n.strokes.some(stroke => stroke.paint.image === null)) {
    if (result === n) result = { ...n }
    result.strokes = n.strokes.map(stroke => {
      if (stroke.paint.image !== null) return stroke
      const paint = { ...stroke.paint }; delete paint.image
      return { ...stroke, paint }
    })
  }
  return result
}
export function applyDocumentPatch(doc: DesignDocument, patch: DocumentPatch): DesignDocument {
  const ids = Object.keys(patch.nodes)
  const next = { ...doc, nodes: ids.length ? { ...doc.nodes } : doc.nodes }
  for (const [key, value] of Object.entries(patch.fields)) {
    if (value === null) delete (next as unknown as Record<string, unknown>)[key]
    else Object.assign(next, { [key]: value })
  }
  for (const [id, node] of Object.entries(patch.nodes)) {
    if (node) next.nodes[id] = nodeFromKernel(node)
    else delete next.nodes[id]
  }
  // Reserved root replacement is not produced by documentPatch, but legacy
  // callers may supply it. It has no bounded node-change proof.
  if (!Object.hasOwn(patch.fields, 'nodes')) rememberTransition(doc, next, ids)
  return next
}
