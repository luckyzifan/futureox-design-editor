import type { DesignNode, Point } from './model'
import { apply, bounds, boxPoints } from './geometry'
/** Select the nearest row/column first; X alone cannot order wrapped layouts. */
export function wrappedInsertion(
  nodes: Record<string, DesignNode>,
  flow: string[],
  cursor: Point,
  axis: 0 | 1,
): string | undefined {
  const main = axis ? cursor.y : cursor.x,
    cross = axis ? cursor.x : cursor.y
  let closest = -1,
    bestCross = Infinity,
    bestMain = Infinity,
    center = 0
  for (let i = 0; i < flow.length; i++) {
    const n = nodes[flow[i]],
      box = bounds(
        boxPoints({ x: 0, y: 0, width: n.width, height: n.height }).map((p) =>
          apply(n.transform, p),
        ),
      )
    const start = axis ? box.x : box.y,
      extent = axis ? box.width : box.height,
      mid = (axis ? box.y : box.x) + (axis ? box.height : box.width) / 2
    const dc = Math.max(start - cross, 0, cross - start - extent),
      dm = Math.abs(main - mid)
    if (dc < bestCross || (Math.abs(dc - bestCross) < 1e-7 && dm < bestMain)) {
      closest = i
      bestCross = dc
      bestMain = dm
      center = mid
    }
  }
  return closest < 0 ? undefined : flow[closest + (main < center ? 0 : 1)]
}
