import { exactBlendLattice } from './effect-region'
import { intersect, type Rect } from './types'
const f = Math.fround
/** Keep mode 6/50's original f32 subtraction, phase and four bilinear loads.
 * A changed texture origin can change fract(q), even with integer bounds.
 * Certify each independent axis before using a smaller physical filter plane. */
export function shadowFilterRegion(original: Rect, output: Rect, offsetX: number, offsetY: number): Rect | undefined {
  if (!exactBlendLattice([original, output]) || output.w < 1 || output.h < 1 || output.w > 8192 || output.h > 8192 ||
      !Number.isFinite(offsetX) || !Number.isFinite(offsetY)) return
  const offsets = [f(offsetX), f(offsetY)]
  const x = Math.floor(f(output.x + .5 - offsets[0])) - 2
  const y = Math.floor(f(output.y + .5 - offsets[1])) - 2
  const right = Math.ceil(f(output.x + output.w - .5 - offsets[0])) + 2
  const bottom = Math.ceil(f(output.y + output.h - .5 - offsets[1])) + 2
  const region = intersect(original, { x, y, w: right - x, h: bottom - y })
  if (!region.w || !region.h || !exactBlendLattice([region])) return
  for (const axis of [0, 1]) {
    const key = axis === 0 ? 'x' : 'y', size = axis === 0 ? 'w' : 'h'
    const length = output[size], oldOrigin = original[key], end = region[key] + region[size]
    const matches = (nextOrigin: number) => {
      for (let i = 0; i < length; i++) {
        const p = f(f(output[key] + i + .5) - offsets[axis])
        const oldQ = f(f(p - oldOrigin) - .5), nextQ = f(f(p - nextOrigin) - .5)
        const oldPhase = f(oldQ - Math.floor(oldQ)), nextPhase = f(nextQ - Math.floor(nextQ))
        const oldBase = f(f(Math.floor(oldQ) + oldOrigin) + .5), nextBase = f(f(Math.floor(nextQ) + nextOrigin) + .5)
        if (!Object.is(oldPhase, nextPhase) || !Object.is(oldBase, nextBase)) return false
      }
      return true
    }
    // Widen storage toward the original origin until subtraction keeps its
    // old f32 phase. This preserves exact sampling instead of rounding an
    // authored fractional offset to obtain a smaller allocation.
    for (let padding = 1; !matches(region[key]); padding *= 2) {
      if (region[key] === oldOrigin) return
      region[key] = Math.max(oldOrigin, region[key] - padding)
      region[size] = end - region[key]
      if (region[size] > 8192) return
    }
  }
  return region
}
