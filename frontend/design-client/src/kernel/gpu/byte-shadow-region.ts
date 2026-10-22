import { planByteTentPrefix } from './byte-tent-prefix-plan'
import { intersect, type Rect } from './types'

/** The legacy byte filter stores only source.rect. Sampling beyond that
 * rectangle is transparent, even if an extended convolution would be nonzero.
 * Keep that domain, its integer phase and both real byte-quantized axes. */
export function byteShadowRegion(source: Rect, output: Rect, radius: number, dx: number, dy: number) {
  if (![radius, dx, dy].every(Number.isSafeInteger) || radius < 1 || radius > 2048 ||
      ![dx, dy].every(value => Math.fround(value) === value)) return
  for (const r of [source, output]) if (![r.x, r.y, r.w, r.h].every(Number.isSafeInteger) ||
      r.w < 1 || r.h < 1 || r.w > 8192 || r.h > 8192 || r.w * r.h > 16777216 ||
      [r.x, r.y, r.x + r.w, r.y + r.h].some(value => Math.abs(value) + radius + 1 > 1048576)) return
  const shifted = { ...output, x: output.x - dx, y: output.y - dy }
  if ([shifted.x, shifted.y, shifted.x + shifted.w, shifted.y + shifted.h]
    .some(value => !Number.isSafeInteger(value) || Math.abs(value) + radius + 1 > 1048576)) return
  const filtered = intersect(source, shifted)
  const stable = { source: Object.freeze({ ...source }), output: Object.freeze({ ...output }),
    shifted: Object.freeze(shifted), radius, dx, dy }
  if (!filtered.w || !filtered.h) return { ...stable, horizontal: undefined, filtered: undefined,
    horizontalPlan: undefined, verticalPlan: undefined }
  const horizontal = { x: filtered.x, y: source.y, w: filtered.w, h: source.h }
  const horizontalPlan = planByteTentPrefix({ radius, axis: 0, source, output: horizontal })
  const verticalPlan = planByteTentPrefix({ radius, axis: 1, source: horizontal, output: filtered })
  if (!horizontalPlan || !verticalPlan) return
  return { ...stable, horizontal: Object.freeze(horizontal), filtered: Object.freeze(filtered), horizontalPlan, verticalPlan }
}
