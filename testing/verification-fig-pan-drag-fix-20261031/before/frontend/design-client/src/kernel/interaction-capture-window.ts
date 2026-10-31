import type {Bounds} from '../model'

/** Retain recently visited output when a local drag reverses direction. This
 * selects a fresh compiler crop, never reuses pixels as a completeness proof.
 * Grow only below one native megapixel and existing texture-axis limits; large
 * or long monotonic gestures retain the original bounded recapture behavior. */
export function expandedInteractionCapture(previous: Bounds | undefined, next: Bounds, scale: number): Bounds {
  if (!previous || !Number.isFinite(scale) || scale <= 0) return next
  if ([previous, next].some(b => ![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.width <= 0 || b.height <= 0)) return next
  const x = Math.min(previous.x, next.x), y = Math.min(previous.y, next.y)
  const right = Math.max(previous.x + previous.width, next.x + next.width)
  const bottom = Math.max(previous.y + previous.height, next.y + next.height)
  const width = Math.ceil(right * scale) - Math.floor(x * scale)
  const height = Math.ceil(bottom * scale) - Math.floor(y * scale)
  if (![width, height].every(Number.isSafeInteger) || width > 8192 || height > 8192 || width * height > 1_048_576) return next
  return {x, y, width: right - x, height: bottom - y}
}
