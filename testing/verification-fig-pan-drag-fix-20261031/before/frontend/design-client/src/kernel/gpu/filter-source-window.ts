import type { Rect } from './types'

/** Mode 22's dedicated exact shaders reserve u52 for a physical read origin.
 * Other compositor modes use these words for gradient alpha; never touch them. */
export const FILTER_SOURCE_WINDOW_OFFSET = 208
export type FilterSourceWindow = Readonly<Rect>
type PhysicalTexture = { width: number; height: number; format: string }

/** Geometry only, never a finite/opaque/content certificate. The caller still
 * proves driver ownership and target/source nonaliasing. Logical dimensions
 * remain u1.zw, so prefix quantum and scalar zero padding use the same window. */
export function snapshotFilterSourceWindow(source: PhysicalTexture | undefined, base: Float32Array,
  value: unknown): FilterSourceWindow | undefined {
  if (!source || source.format !== 'rgba32float' || !(base instanceof Float32Array) || !(base.buffer instanceof ArrayBuffer) || base.length !== 256 ||
      !value || typeof value !== 'object') return
  const { x, y, w, h } = value as Rect
  if (![source.width, source.height, x, y, w, h].every(Number.isSafeInteger) ||
      source.width < 1 || source.height < 1 || source.width > 16384 || source.height > 16384 ||
      x < 0 || y < 0 || w < 1 || h < 1 || x + w > source.width || y + h > source.height ||
      base[6] !== w || base[7] !== h ||
      !base.subarray(4, 6).every(v => Number.isSafeInteger(v) && Math.abs(v) <= 1048576)) return
  return Object.freeze({ x, y, w, h })
}

/** Caller arrays never receive private addressing. Ordinary zero-filled
 * uniforms keep their existing allocation behavior; unknown raw u52 is cleared. */
export function filterSourceWindowUniforms(base: Float32Array, window?: FilterSourceWindow): Float32Array {
  const at = FILTER_SOURCE_WINDOW_OFFSET
  if (!window && base[at] === 0 && base[at + 1] === 0 && base[at + 2] === 0 && base[at + 3] === 0) return base
  const copy = base.slice()
  copy.set(window ? [window.x, window.y, 1, 0] : [0, 0, 0, 0], at)
  return copy
}
