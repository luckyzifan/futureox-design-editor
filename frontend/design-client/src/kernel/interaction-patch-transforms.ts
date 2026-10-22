import type { DesignDocument, Matrix } from '../model'
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
