import type { Bounds, Matrix, Point } from '../model'
import { inverse, multiply, nearestPixel, stablePixelEdge, translate, unionBounds } from './affine'
import type { CommandProfile } from './profiles'

export type ArrangementMode = 'start' | 'center' | 'end' | 'distribute'
export interface ArrangementPlan { profile: CommandProfile; offsets: Point[]; pixelOffsets?: Point[] }

function pixelDistribution(order: readonly { r: Bounds; index: number }[], offsets: readonly Point[], axis: 'x' | 'y', overlap: boolean) {
  const first = order[0].r, last = order.at(-1)!.r, inner = order.slice(1, -1)
  const size = axis === 'x' ? 'width' : 'height'
  const separation = (r: Bounds) => overlap ? 0 : r[size]
  // Keep both anchors. Reserve room for every remaining layer from the right
  // before fitting each inner layer as close as possible to its exact position.
  const latest = new Array<number>(inner.length)
  let right = last[axis]
  for (let i = inner.length - 1; i >= 0; i--) {
    right = Math.floor(stablePixelEdge(right - separation(inner[i].r)))
    latest[i] = right
  }
  const fitted = [...offsets]
  let left = first[axis] + separation(first), priorExact = first[axis], changed = false
  for (const [i, { r, index }] of inner.entries()) {
    const exact = r[axis] + offsets[index][axis]
    // Signed gaps remain supported. When the exact command crosses layer
    // origins, keep that plan without offering an order-changing substitute.
    if (exact < priorExact - 1e-9 || exact > last[axis] + 1e-9) return undefined
    priorExact = exact
    const earliest = Math.ceil(stablePixelEdge(left))
    if (earliest > latest[i]) return undefined
    const position = Math.max(earliest, Math.min(latest[i], nearestPixel(exact)))
    if (position !== stablePixelEdge(exact)) {
      fitted[index] = { ...offsets[index], [axis]: position - r[axis] }
      changed = true
    }
    left = position + separation(r)
  }
  return changed ? fitted : undefined
}
/** Bounds are measured by the adapter against its exact snapshot/candidate.
 * The internal Core tag identifies that contract; it grants no authority and measures no geometry.
 * Offsets follow input order. Distribution keeps the original ordered endpoints and accepts signed gaps. */
export function planArrangement(profile: CommandProfile, rects: readonly Bounds[], axis: 'x' | 'y', mode: ArrangementMode,
  parent?: Bounds, reference?: Bounds, fitPixels = false): ArrangementPlan | null {
  if (!rects.length || (mode === 'distribute' ? rects.length < 3 : rects.length === 1 && !parent)) return null
  const size = axis === 'x' ? 'width' : 'height'
  const offsets: Point[] = new Array(rects.length)
  const point = (delta: number): Point => axis === 'x' ? { x: delta, y: 0 } : { x: 0, y: delta }
  if (mode === 'distribute') {
    const order = rects.map((r, index) => ({ r, index })).sort((a, b) => a.r[axis] - b.r[axis])
    const first = order[0].r, last = order[order.length - 1].r
    const span = last[axis] + last[size] - first[axis]
    const gap = (span - order.reduce((sum, { r }) => sum + r[size], 0)) / (order.length - 1)
    let cursor = first[axis]
    for (let at = 0; at < order.length; at++) {
      const { r, index } = order[at]
      // Pin the original endpoints exactly, including fractional-gap roundoff.
      offsets[index] = point(at === 0 || at === order.length - 1 ? 0 : cursor - r[axis])
      cursor += r[size] + gap
    }
    const pixelOffsets = fitPixels ? pixelDistribution(order, offsets, axis, gap < 0) : undefined
    if (pixelOffsets) return { profile, offsets, pixelOffsets }
  } else {
    const box = reference ?? (rects.length >= 2 ? unionBounds([...rects]) : parent!)
    rects.forEach((r, index) => {
      const target = mode === 'start' ? box[axis] : mode === 'end' ? box[axis] + box[size] - r[size] : box[axis] + (box[size] - r[size]) / 2
      offsets[index] = point(target - r[axis])
    })
  }
  return { profile, offsets }
}
/** Convert a measured world-space move to the node's parent-local transform. */
export function translatedLocalTransform(parentWorld: Matrix, world: Matrix, delta: Point): Matrix {
  return multiply(inverse(parentWorld), multiply(translate(delta.x, delta.y), world))
}
