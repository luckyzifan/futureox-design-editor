import { apply, distance, inverse } from './geometry'
import type { Matrix, Network, Point } from './model'

/** Preserve the grabbed local point when the displayed and live transforms
 * differ. Subsequent movement is still measured in displayed world units. */
export function remapPointerAnchor(displayed: Matrix, current: Matrix, point: Point): Point {
  return apply(current, apply(inverse(displayed), point))
}

/** A displayed endpoint is identified by its stable ID. Its current geometry
 * stays authoritative; removed endpoints cannot be reintroduced by an old frame. */
export function presentedPenVertex(live: Network, shown: Network, matrix: Matrix, worldPoint: Point, zoom: number) {
  let nearest: Network['vertices'][number] | undefined, limit = 8 / zoom
  for (const vertex of shown.vertices) {
    const current = live.vertices.find(value => value.id === vertex.id)
    if (!current) continue
    const delta = distance(apply(matrix, vertex), worldPoint)
    if (delta < limit) { limit = delta; nearest = current }
  }
  return nearest
}
