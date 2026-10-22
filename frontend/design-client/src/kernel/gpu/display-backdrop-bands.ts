import { prefixSamplingGeometry } from './prefix-sampling-geometry'
import { parameters, type Rect } from './types'

/** Prove actual scalar/prefix texel indices before replacing a whole filter
 * by row outputs or by a saved vertical column. This is an address proof,
 * not a color/kernel or display-quality certificate. */
export function planDisplayBackdropBands(input: Rect, radius: number, clampEdges: boolean) {
  if (!Number.isFinite(radius) || radius < 1 || radius > 2048 ||
      ![input.x, input.y].every(value => Number.isFinite(value) && Math.abs(value) <= 1048576) ||
      ![input.w, input.h].every(value => Number.isSafeInteger(value) && value > 0 && value <= 8192) ||
      input.w * input.h > 16777216) return
  const source = { ...input }, rows: Rect[] = [], columns: Rect[] = []
  const prove = (output: Rect, from: Rect, axis: 0 | 1, along: number, cross: number) => {
    const u = parameters(output, from)
    u[37] = axis; u[38] = clampEdges ? 1 : 0
    const geometry = prefixSamplingGeometry(u, radius, true)
    return !!geometry && geometry.offset === along + geometry.padding && geometry.crossOffset === cross
  }
  // A whole-output control also proves the original non-rebased address lane.
  if (!prove(source, source, 0, 0, 0) || !prove(source, source, 1, 0, 0)) return
  for (let row = 0; row < source.h; row += 64) {
    const output = { ...source, y: source.y + row, h: Math.min(64, source.h - row) }
    if (!prove(output, source, 0, 0, row)) return
    rows.push(output)
  }
  for (let column = 0; column < source.w; column += 64) {
    const output = { ...source, x: source.x + column, w: Math.min(64, source.w - column) }
    if (!prove(output, source, 1, 0, column) || !prove(output, output, 1, 0, 0)) return
    columns.push(output)
  }
  return { source, rows, columns }
}
