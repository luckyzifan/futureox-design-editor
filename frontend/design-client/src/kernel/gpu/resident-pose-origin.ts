import type { GpuScene } from './types'

export type ResidentPoseOrigin = readonly [number, number]
const finitePosition = (value: number) => Number.isFinite(value) && Math.abs(value) < 1_000_000

/** A pose window is anchored to the original capture, not the most recently
 * recompiled node. Native recompilation replaces moving-node source identities;
 * retaining their initial two coordinates avoids retaining the entire scene. */
export function capturePoseOrigins(scene: GpuScene, ids: readonly string[]): ReadonlyMap<string, ResidentPoseOrigin> | undefined {
  if (!ids.length || ids.length > 16 || new Set(ids).size !== ids.length) return
  const origins = new Map<string, ResidentPoseOrigin>()
  for (const id of ids) {
    const node = scene.nodes[id], matrix = node?.matrix
    if (!node || node.id !== id || !Array.isArray(matrix) || matrix.length !== 6 ||
        !matrix.every(Number.isFinite) || !finitePosition(matrix[4]) || !finitePosition(matrix[5])) return
    origins.set(id, Object.freeze([matrix[4], matrix[5]] as const))
  }
  return origins
}

/** Preserve the existing current-matrix-plus-delta arithmetic, but measure its
 * result from the immutable capture origin. Repeating an absolute pose then
 * keeps the same cumulative window instead of shrinking it back to the origin. */
export function residentPoseShift(origin: ResidentPoseOrigin, currentMatrix: number[],
  delta: readonly [number, number]): { x: number; y: number } | undefined {
  if (!Array.isArray(origin) || origin.length !== 2 || !origin.every(finitePosition) ||
      !Array.isArray(currentMatrix) || currentMatrix.length !== 6 || !currentMatrix.every(Number.isFinite) ||
      !finitePosition(currentMatrix[4]) || !finitePosition(currentMatrix[5]) ||
      !Array.isArray(delta) || delta.length !== 2 || !delta.every(finitePosition)) return
  const x = currentMatrix[4] + delta[0] - origin[0], y = currentMatrix[5] + delta[1] - origin[1]
  return finitePosition(x) && finitePosition(y) ? { x, y } : undefined
}
