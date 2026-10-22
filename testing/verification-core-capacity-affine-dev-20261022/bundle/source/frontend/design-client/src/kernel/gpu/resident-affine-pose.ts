import type { Matrix } from '../../model'
import { inverse, multiply } from '../../geometry'
import type { GpuScene } from './types'
import { sceneIndex } from './scene-index'

/** Delta from authored world chrome to the already compiled resident pose. */
export function residentOverlayAffines(scene: GpuScene, transforms: Record<string, Matrix>): Record<string, Matrix> {
  const parents = sceneIndex(scene).parents, result: Record<string, Matrix> = {}
  const camera: Matrix = [scene.view.zoom, 0, 0, scene.view.zoom, scene.view.x, scene.view.y]
  if (!camera.every(Number.isFinite) || camera[0] <= 0) return result
  const world = inverse(camera)
  for (const [id, transform] of Object.entries(transforms)) {
    const node = scene.nodes[id], parentId = parents.get(id), parent = parentId ? scene.nodes[parentId]?.matrix : camera
    if (!node || !parent || !transform.every(Number.isFinite)) continue
    const authored = multiply(world, multiply(parent, transform))
    if (Math.abs(authored[0] * authored[3] - authored[1] * authored[2]) < 1e-12) continue
    const delta = multiply(multiply(world, node.matrix), inverse(authored))
    if (delta.every(Number.isFinite)) result[id] = delta
  }
  return result
}
