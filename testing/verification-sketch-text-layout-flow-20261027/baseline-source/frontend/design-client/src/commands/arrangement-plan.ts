import type { Bounds, Matrix, Point } from '../model'
import { inverse, multiply, translate, unionBounds } from './affine'
import type { CommandProfile } from './profiles'

export type ArrangementMode = 'start' | 'center' | 'end' | 'distribute'
export interface ArrangementPlan { profile: CommandProfile; offsets: Point[] }
/** Bounds are measured by the adapter against its exact snapshot/candidate.
 * The internal Core tag identifies that contract; it grants no authority and measures no geometry.
 * Offsets follow input order. The shared command handles two-node no-change and rejects ambiguous overlap before this >=3/equal-gap primitive. */
export function planArrangement(profile: CommandProfile, rects: readonly Bounds[], axis: 'x' | 'y', mode: ArrangementMode, parent?: Bounds): ArrangementPlan | null {
  if (!rects.length || (mode === 'distribute' ? rects.length < 3 : rects.length === 1 && !parent)) return null
  const size = axis === 'x' ? 'width' : 'height'
  const box = rects.length >= 2 ? unionBounds([...rects]) : parent!
  const offsets: Point[] = new Array(rects.length)
  const point = (delta: number): Point => axis === 'x' ? { x: delta, y: 0 } : { x: 0, y: delta }
  if (mode === 'distribute') {
    const order = rects.map((r, index) => ({ r, index })).sort((a, b) => a.r[axis] - b.r[axis])
    const gap = (box[size] - order.reduce((sum, { r }) => sum + r[size], 0)) / (order.length - 1)
    let cursor = box[axis]
    for (let at = 0; at < order.length; at++) {
      const { r, index } = order[at]
      // Pin the original endpoints exactly, including fractional-gap roundoff.
      offsets[index] = point(at === 0 || at === order.length - 1 ? 0 : cursor - r[axis])
      cursor += r[size] + gap
    }
  } else rects.forEach((r, index) => {
    const target = mode === 'start' ? box[axis] : mode === 'end' ? box[axis] + box[size] - r[size] : box[axis] + (box[size] - r[size]) / 2
    offsets[index] = point(target - r[axis])
  })
  return { profile, offsets }
}
/** Convert a measured world-space move to the node's parent-local transform. */
export function translatedLocalTransform(parentWorld: Matrix, world: Matrix, delta: Point): Matrix {
  return multiply(inverse(parentWorld), multiply(translate(delta.x, delta.y), world))
}
