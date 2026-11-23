import { inverse } from '../commands/affine'
import type { Matrix } from '../model'

/** One color stop already checked by the caller. Offset is the native 0–1 parameter. */
export type GradientStopCss = { offset: number; color: string }

/** Same rounding as the rest of code.export. Undefined means the value cannot be a safe CSS number. */
function formatCssNumber(value: number): string | undefined {
  if (!Number.isFinite(value) || Math.abs(value) > 1e12) return undefined
  return String(Math.round(value * 1e6) / 1e6)
}

type LinearField = {
  /** Partial derivatives of the native parameter in normalized node UV. */
  gu: number
  gv: number
  tAt: (u: number, v: number) => number
}

/**
 * Native linear parameter. Without a paint transform this is the normalized
 * projection used by the kernel (`(u-0.5)cos + (v-0.5)sin` over `|cos|+|sin|`).
 * With a transform, the kernel samples `u` after the inverse map, so the
 * authored angle is not the direction.
 */
function linearField(angle: number, transform?: Matrix): LinearField | undefined {
  if (transform) {
    let inverted: Matrix
    try { inverted = inverse(transform) } catch { return undefined }
    const gu = inverted[0], gv = inverted[2], translate = inverted[4]
    return { gu, gv, tAt: (u, v) => gu * u + gv * v + translate }
  }
  if (!Number.isFinite(angle)) return undefined
  const radians = (angle * Math.PI) / 180
  const cos = Math.cos(radians), sin = Math.sin(radians)
  const denom = Math.abs(cos) + Math.abs(sin)
  if (!(denom > 0)) return undefined
  const gu = cos / denom, gv = sin / denom
  return { gu, gv, tAt: (u, v) => (u - 0.5) * gu + (v - 0.5) * gv + 0.5 }
}

/**
 * CSS `linear-gradient` angle is clockwise from up, in pixel space, and its
 * 0%–100% line always crosses the padding box. The kernel parameter is affine
 * in normalized UV. Emit the pixel-space angle of that field and shift stop
 * positions so each native offset lands on the same point.
 */
export function cssLinearGradient(
  width: number,
  height: number,
  angle: number,
  transform: Matrix | undefined,
  stops: readonly GradientStopCss[],
): string | undefined {
  if (!(width > 0) || !(height > 0) || !stops.length) return undefined
  const field = linearField(angle, transform)
  if (!field) return undefined
  const gx = field.gu / width, gy = field.gv / height
  const magnitude = Math.hypot(gx, gy)
  if (!(magnitude > 0)) return undefined
  const ux = gx / magnitude, uy = gy / magnitude
  const cssLength = Math.abs(width * ux) + Math.abs(height * uy)
  const scale = magnitude * cssLength
  if (!(scale > 0)) return undefined
  const center = field.tAt(0.5, 0.5)
  // `atan2(gx, -gy)` is the CSS angle, but `-0` makes an upward/right check
  // land on the wrong quadrant. A zero vertical derivative is exactly horizontal.
  const degrees = Math.atan2(gx, gy === 0 ? 0 : -gy) * (180 / Math.PI)
  const angleText = formatCssNumber(degrees)
  if (angleText === undefined) return undefined
  const ordered = [...stops].sort((left, right) => left.offset - right.offset)
  const parts: string[] = []
  for (const stop of ordered) {
    if (!Number.isFinite(stop.offset) || !stop.color) return undefined
    const position = formatCssNumber((0.5 + (stop.offset - center) / scale) * 100)
    if (position === undefined) return undefined
    parts.push(`${stop.color} ${position}%`)
  }
  return `linear-gradient(${angleText}deg,${parts.join(',')})`
}

/**
 * Radial parameter after the paint transform: `hypot(2(u'-0.5), 2(v'-0.5))`
 * where `(u', v')` is node UV mapped by the inverse transform. The t=1 set is
 * the image of the gradient-space disk centered at (0.5, 0.5) with radius 0.5.
 * CSS can express that disk only when the image is an axis-aligned ellipse.
 * A rotated non-circular ellipse returns undefined instead of a centered fake.
 */
function radialEllipse(transform: Matrix | undefined): string | undefined {
  if (!transform) return 'ellipse closest-side at center'
  const [a, b, c, d, e, f] = transform
  if (![a, b, c, d, e, f].every(value => Number.isFinite(value))) return undefined
  const horizontal = Math.hypot(a, c)
  const vertical = Math.hypot(b, d)
  if (!(horizontal > 0) || !(vertical > 0)) return undefined
  // Rows of the linear map are orthogonal exactly when the disk stays axis-aligned.
  if (Math.abs(a * b + c * d) > 1e-6 * horizontal * vertical) return undefined
  const rx = formatCssNumber(horizontal * 50)
  const ry = formatCssNumber(vertical * 50)
  const cx = formatCssNumber((a * 0.5 + c * 0.5 + e) * 100)
  const cy = formatCssNumber((b * 0.5 + d * 0.5 + f) * 100)
  if (rx === undefined || ry === undefined || cx === undefined || cy === undefined) return undefined
  if (Number(rx) === 0 || Number(ry) === 0) return undefined
  return `ellipse ${rx}% ${ry}% at ${cx}% ${cy}%`
}

export function cssRadialGradient(stops: readonly GradientStopCss[], transform?: Matrix): string | undefined {
  if (!stops.length) return undefined
  const shape = radialEllipse(transform)
  if (!shape) return undefined
  const ordered = [...stops].sort((left, right) => left.offset - right.offset)
  const parts: string[] = []
  for (const stop of ordered) {
    if (!Number.isFinite(stop.offset) || !stop.color) return undefined
    const position = formatCssNumber(stop.offset * 100)
    if (position === undefined) return undefined
    parts.push(`${stop.color} ${position}%`)
  }
  return `radial-gradient(${shape},${parts.join(',')})`
}
