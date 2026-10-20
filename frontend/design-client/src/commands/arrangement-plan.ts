import type { Bounds, Matrix, Point } from '../model'
import { inverse, multiply, translate, unionBounds } from './affine'
import type { CommandProfile } from './profiles'

export type ArrangementMode = 'start' | 'center' | 'end' | 'distribute'
export interface ArrangementPlan { profile: CommandProfile; offsets: Point[] }
/** Bounds are measured by the adapter against its exact snapshot/candidate.
 * Profiles identify that contract; they neither choose permissions nor measure geometry.
 * Offsets follow input order. Distribution retains the existing >=3/equal-gap rule. */
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
    for (const { r, index } of order) { offsets[index] = point(cursor - r[axis]); cursor += r[size] + gap }
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
