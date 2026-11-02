import { around, inverse, multiply, rotate } from './geometry'
import type { Matrix, Point } from './model'

/** Local x-axis angle in Figma's Design panel.
 * Positive is counterclockwise. The range follows atan2, [-180, 180]. */
export function figmaRotationDegrees(matrix: Matrix) {
  const degrees = (-Math.atan2(matrix[1], matrix[0]) * 180) / Math.PI
  return Number.isFinite(degrees) ? degrees : 0
}

/** At most two decimal places. Trailing zeros are omitted. Values outside
 * [-180, 180] wrap the way the Design panel does after you pass a half turn. */
export function formatFigmaAngle(degrees: number): string {
  if (!Number.isFinite(degrees)) return '0'
  let value = Number(degrees.toFixed(2))
  if (value > 180 || value < -180) {
    value = ((value + 180) % 360 + 360) % 360 - 180
    if (value === -180) value = 180
  }
  if (value === 0 || Object.is(value, -0)) return '0'
  return String(value)
}

/** Shift-snap the layer's own Figma angle to 15°. `delta` is the unsnapped
 * world rotation already applied around `center`. */
export function snapRotationDelta(parent: Matrix, worldStart: Matrix, delta: Matrix, center: Point): Matrix {
  let local: Matrix
  try { local = multiply(inverse(parent), multiply(delta, worldStart)) }
  catch { return delta }
  const angle = figmaRotationDegrees(local)
  const snapped = Math.round(angle / 15) * 15
  const correction = snapped - angle
  if (Math.abs(correction) < 1e-6) return delta
  // A positive Figma correction is counterclockwise, which is rotate(-correction).
  return multiply(around(center, rotate(-correction)), delta)
}

export type LiveRotation = {
  session: number
  page: string
  documentId: string
  textById: Readonly<Record<string, string>>
}

export function sameLiveRotation(a: LiveRotation | null, b: LiveRotation | null) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.session !== b.session || a.page !== b.page || a.documentId !== b.documentId) return false
  const keys = Object.keys(a.textById)
  return keys.length === Object.keys(b.textById).length && keys.every(id => a.textById[id] === b.textById[id])
}
