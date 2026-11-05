import type { DesignDocument, DesignNode, Matrix } from '../model'
import { equalValue, type DocumentPatch } from '../document-patch'

/** Rendering-lane optimization only. Native validates semantic dependency and
 * transform admission; a miss takes the ordinary authoritative patch route. */
export function interactionPatchTransforms(before: DesignDocument, patch: DocumentPatch,
  selection: readonly string[]): Record<string, Matrix> | null {
  const ids = Object.keys(patch.nodes)
  if (!ids.length || ids.length > 16 || Object.keys(patch.fields).length ||
      ids.some(id => !selection.includes(id))) return null
  const transforms: Record<string, Matrix> = {}
  for (const id of ids) {
    const old = before.nodes[id], next = patch.nodes[id]
    if (!old || !next || Object.keys(old).length !== Object.keys(next).length ||
        Object.keys(next).some(key => key !== 'transform' && !equalValue(old[key as keyof typeof old], next[key as keyof typeof next])) ||
        next.transform.length !== 6 || !next.transform.every(Number.isFinite)) return null
    transforms[id] = next.transform
  }
  return transforms
}

/** The UI may tighten the overlay for this class. Commit footprints still
 * come from Rust's validated old/new path bounds and dependency checks. */
export function isInnerShadowFill(n: DesignNode | undefined): boolean {
  return !!n && n.kind === 'vector' && n.blend === 'normal' && !n.mask && !n.children.length &&
    !n.strokes.some(s => s.visible) && n.fills.some(p => p.visible) &&
    n.effects.some(e => e.visible) && n.effects.every(e => !e.visible || e.kind === 'inner-shadow')
}

/** Compare the two authored projections after applyDocumentPatch. A wire
 * image:null on a solid paint has already been normalized on this lane. */
export function isInnerShadowPosePatch(before:DesignDocument, after:DesignDocument, patch:DocumentPatch):boolean {
  const ids=Object.keys(patch.nodes)
  if (ids.length!==1 || Object.keys(patch.fields).length) return false
  const [id]=ids, next=after.nodes[id]
  if (!patch.nodes[id] || !next || !isInnerShadowFill(before.nodes[id])) return false
  return !!interactionPatchTransforms(before,{nodes:{[id]:next},fields:{}},ids)
}
