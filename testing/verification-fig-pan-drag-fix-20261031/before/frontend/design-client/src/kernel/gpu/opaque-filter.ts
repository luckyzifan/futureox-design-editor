import { exactBlendLattice } from './effect-region'
import type { Rect } from './types'

/** Geometry proof only: callers separately certify alpha=1 for every source
 * texel. A complete one-axis footprint excludes the filter's zero-padded edge;
 * the other axis must remain inside the same exact integer device lattice. */
export function completeFilterAxisSupport(input: Rect, output: Rect, axis: number, radius: number): boolean {
  if ((axis !== 0 && axis !== 1) || !Number.isFinite(radius) || radius <= 0 || radius > 2048 ||
      !exactBlendLattice([input, output]) || input.w <= 0 || input.h <= 0 || output.w <= 0 || output.h <= 0 ||
      output.x < input.x || output.y < input.y || output.x + output.w > input.x + input.w ||
      output.y + output.h > input.y + input.h) return false
  const reach = Math.ceil(radius) + 1
  return axis === 0 ? output.x - reach >= input.x && output.x + output.w + reach <= input.x + input.w
    : output.y - reach >= input.y && output.y + output.h + reach <= input.y + input.h
}
