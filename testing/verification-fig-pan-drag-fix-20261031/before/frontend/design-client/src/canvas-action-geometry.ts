import type { DesignDocument, DesignNode } from './model'
/** Private ephemeral arithmetic only. Never pass these arrays to a diagnostic sink. */
export function actionGeometry(document: DesignDocument, ids: readonly string[], patches?: Record<string, Partial<DesignNode>>): number[] | undefined {
  if (!ids.length || ids.length > 16) return
  const values: number[] = []
  for (const id of ids) {
    const node = document.nodes[id]; if (!node) return
    const patch = patches?.[id]
    values.push(...(patch?.transform || node.transform), patch?.width ?? node.width, patch?.height ?? node.height)
  }
  return values.every(Number.isFinite) ? values : undefined
}
/**0 unobserved;1 equal;2 different;3 unsupported. Equality allows only floating arithmetic noise. */
export function compareActionGeometry(expected?: readonly number[], actual?: readonly number[]): 0 | 1 | 2 | 3 {
  if (!expected || !actual) return 3
  if (expected.length !== actual.length) return 2
  return expected.every((v, i) => Math.abs(v - actual[i]) <= 1e-9 * Math.max(1, Math.abs(v), Math.abs(actual[i]))) ? 1 : 2
}
