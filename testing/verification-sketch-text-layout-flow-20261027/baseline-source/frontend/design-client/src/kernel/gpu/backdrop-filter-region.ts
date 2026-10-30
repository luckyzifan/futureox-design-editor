import type { Rect } from './types'

/** Preserve the captured texture's pixel lattice. The caller still uses the
 * original mode27 clamp/resample; include its bilinear neighbours and a two
 * pixel conservative guard, clipping only at the real capture edges. */
export function backdropFilterRegion(input: Rect, required: readonly number[] | undefined): Rect | undefined {
  if (!required || required.length !== 4 || ![...Object.values(input), ...required].every(Number.isFinite) ||
      ![input.w, input.h].every(v => Number.isSafeInteger(v) && v > 0 && v <= 16384) ||
      Math.abs(input.x) > 1048576 || Math.abs(input.y) > 1048576 ||
      !required.every(v => Number.isSafeInteger(v) && Math.abs(v) <= 1048576) ||
      required[2] <= 0 || required[3] <= 0 || required[2] > 16384 || required[3] > 16384) return
  const range = (origin: number, size: number, start: number, extent: number) => {
    const first = Math.min(size - 1, Math.max(0, Math.floor(start - origin) - 2))
    const end = Math.min(size, Math.max(first + 1, Math.ceil(start + extent - origin) + 2))
    return [first, end] as const
  }
  const [left, right] = range(input.x, input.w, required[0], required[2])
  const [top, bottom] = range(input.y, input.h, required[1], required[3])
  const output = { x: input.x + left, y: input.y + top, w: right - left, h: bottom - top }
  // Mode27's bilinear weights are authored by its original binary32 global
  // addressing. Equal double-precision lattice offsets alone are insufficient:
  // check the actual clamped q/frac and neighbour textureLoad addresses for
  // every consumed pixel centre on each separable axis. A miss keeps the old
  // full-capture path; no phase is rounded to make the certificate pass.
  const f = Math.fround
  const addressed = (point: number, origin: number, size: number) => {
    origin = f(origin)
    const clamped = Math.max(f(origin + .5), Math.min(f(f(origin + size) - .5), point))
    const q = f(f(clamped - origin) - .5), floor = Math.floor(q), part = f(q - floor)
    const base = f(f(floor + origin) + .5)
    const a = Math.floor(f(base - origin)), b = Math.floor(f(f(base + 1) - origin))
    return { a, b, part }
  }
  for (const [oldOrigin, oldSize, origin, size, start, length, offset] of [
    [input.x, input.w, output.x, output.w, required[0], required[2], left],
    [input.y, input.h, output.y, output.h, required[1], required[3], top],
  ]) for (let pixel = 0; pixel < length; pixel++) {
    const point = f(start + pixel + .5), old = addressed(point, oldOrigin, oldSize), next = addressed(point, origin, size)
    // A zero-weight neighbour at the original physical edge is outside in
    // both paths. Its range is intentionally compared before textureLoad.
    const sameAddress = (a: number, b: number) => a < 0 || a >= oldSize
      ? b < 0 || b >= size : a === b + offset && b >= 0 && b < size
    if (!Object.is(old.part, next.part) || !sameAddress(old.a, next.a) || !sameAddress(old.b, next.b)) return
  }
  return output
}
