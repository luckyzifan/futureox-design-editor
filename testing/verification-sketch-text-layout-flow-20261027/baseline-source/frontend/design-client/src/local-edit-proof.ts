import { documentPatch } from './document-patch'
import { validateStructure, type DesignDocument, type DesignNode, type Paint } from './model'

/** Derived dependencies over an immutable, structurally checked snapshot.
 * Only the exact producer transition below can inherit this index. Pages alone,
 * selection hints, document IDs and revisions never establish its validity. */
type DependencyIndex = { parents: Map<string, string>; translationReferences: boolean; repeats: boolean }
const indices = new WeakMap<DesignDocument, DependencyIndex>()
// Keep at most eight live snapshot mappings. Old undo snapshots must not pin
// a fresh O(document) index after every structural edit. Eviction only rebuilds
// the proof; it never changes edit semantics or authoritative history.
let recentIndices: WeakRef<DesignDocument>[] = []
function rememberIndex(document: DesignDocument, index: DependencyIndex) {
  recentIndices = recentIndices.filter(ref => { const value = ref.deref(); return value && value !== document })
  while (recentIndices.length >= 8) {
    const oldest = recentIndices.shift()!.deref()
    if (oldest) indices.delete(oldest)
  }
  indices.set(document, index)
  recentIndices.push(new WeakRef(document))
}
function dependencies(document: DesignDocument): DependencyIndex {
  const known = indices.get(document)
  if (known) { rememberIndex(document, known); return known }
  validateStructure(document)
  const parents = new Map<string, string>()
  let translationReferences = false, repeats = false
  for (const n of Object.values(document.nodes)) {
    for (const id of n.children) parents.set(id, n.id)
    translationReferences ||= !!(n.connector || n.textPath || (n.board?.kind === 'code-block' && n.board.language))
    repeats ||= !!n.repeat
  }
  const index = { parents, translationReferences, repeats }
  rememberIndex(document, index)
  return index
}
function hasDerivedReferences(n: DesignNode): boolean {
  return !!(n.component || n.componentSet || n.componentKey != null || n.instance || n.instanceOrigin ||
    n.booleanOperation || n.repeat || Object.keys(n.bindings || {}).length ||
    Object.keys(n.styleRefs || {}).length || Object.keys(n.variableModes || {}).length)
}
function solidRecolor(before: Paint[], after: Paint[]): boolean {
  return before.length === after.length && before.every((paint, i) => {
    const next = after[i]
    return paint.kind === 'solid' && next?.kind === 'solid' &&
      [...new Set([...Object.keys(paint), ...Object.keys(next)])].every(key =>
        key === 'color' || key === 'opacity' || Object.is(paint[key as keyof Paint], next[key as keyof Paint]))
  })
}
export type LocalEditProof = Readonly<{ ids: readonly string[]; translation: boolean }>
const proofs = new WeakMap<DesignDocument, { before: WeakRef<DesignDocument>; proof: LocalEditProof }>()
/** Consume only an exact, already checked transition. Missing/expired evidence
 * is a normal full-path fallback, including undo, branches and deserialization. */
export function localEditProof(before: DesignDocument, after: DesignDocument): LocalEditProof | undefined {
  const known = proofs.get(after)
  return known?.before.deref() === before ? known.proof : undefined
}
/** This is a bounded semantic classifier, not validation. The caller still
 * runs the full document validator and authoritative atomic Graph admission.
 * Unknown fields, topology, dimensions, bindings, text, component and constraint
 * edits unconditionally retain the established dependency/layout path. */
export function proveLocalEdit(before: DesignDocument, after: DesignDocument): LocalEditProof | undefined {
  if (before.schemaVersion < 2 || !before.rasterProfile || before.animations?.length) return
  const patch = documentPatch(before, after)
  if (Object.keys(patch.fields).length) return
  const ids = Object.keys(patch.nodes)
  if (!ids.length || ids.length > 4096) return
  let translation = false
  for (const id of ids) {
    const old = before.nodes[id], next = patch.nodes[id]
    if (!old || !next || old.id !== next.id || old.kind !== next.kind || old.children !== next.children ||
      old.board || old.connector || old.textPath || old.pathOffset || old.vectorBrush) return
    for (const field of new Set([...Object.keys(old), ...Object.keys(next)])) {
      if (Object.is(old[field as keyof DesignNode], next[field as keyof DesignNode])) continue
      if (['name', 'locked', 'opacity', 'blend'].includes(field)) continue
      if (field === 'fills' && old.kind !== 'text' && solidRecolor(old.fills, next.fills)) continue
      if (field === 'transform' && !next.children.length && next.transform.length === 6 &&
        next.transform.every(v => Number.isFinite(v) && Math.abs(v) <= 1e7) &&
        next.transform.slice(0, 4).every((v, i) => Object.is(v, old.transform[i]))) {
        translation = true
        continue
      }
      return
    }
  }
  const index = dependencies(before)
  if (index.repeats || (translation && index.translationReferences)) return
  for (const id of ids) {
    let at: string | undefined = id
    while (at) {
      const n = before.nodes[at]
      if (!n || hasDerivedReferences(n) || (translation && (n.constraints ||
        (n.layout && n.layout.mode !== 'none') ||
        (n.sizing && (n.sizing.width !== 'fixed' || n.sizing.height !== 'fixed'))))) return
      at = index.parents.get(at)
    }
  }
  // These fields cannot change parent edges or derived-reference membership.
  rememberIndex(after, index)
  const proof = Object.freeze({ ids: Object.freeze(ids), translation })
  proofs.set(after, { before: new WeakRef(before), proof })
  return proof
}
