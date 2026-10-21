import type { Bounds, Matrix, Point } from '../model'

/** Pure numeric primitives. No native picking, renderer, model factory or Editor dependency. */
export function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ]
}
export function inverse(m: Matrix): Matrix {
  const d = m[0] * m[3] - m[1] * m[2]
  if (Math.abs(d) < 1e-12) throw new Error('不可逆变换')
  return [
    m[3] / d,
    -m[1] / d,
    -m[2] / d,
    m[0] / d,
    (m[2] * m[5] - m[3] * m[4]) / d,
    (m[1] * m[4] - m[0] * m[5]) / d,
  ]
}
export const apply = (m: Matrix, p: Point): Point => ({
  x: m[0] * p.x + m[2] * p.y + m[4],
  y: m[1] * p.x + m[3] * p.y + m[5],
})
export const translate = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y]
export const rotate = (angle: number): Matrix => {
  const r = (angle * Math.PI) / 180
  return [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]
}
export const around = (p: Point, m: Matrix) =>
  multiply(translate(p.x, p.y), multiply(m, translate(-p.x, -p.y)))
export const matrixString = (m: Matrix) => `matrix(${m.join(' ')})`
export const boxPoints = (b: Bounds) => [
  { x: b.x, y: b.y },
  { x: b.x + b.width, y: b.y },
  { x: b.x + b.width, y: b.y + b.height },
  { x: b.x, y: b.y + b.height },
]
export function bounds(points: Point[]): Bounds {
  if (!points.length) return { x: 0, y: 0, width: 0, height: 0 }
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity
  for (const p of points) { x = Math.min(x, p.x); y = Math.min(y, p.y); right = Math.max(right, p.x); bottom = Math.max(bottom, p.y) }
  return { x, y, width: right - x, height: bottom - y }
}
export function unionBounds(bs: Bounds[]): Bounds {
  if (!bs.length) return { x: 0, y: 0, width: 0, height: 0 }
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity
  for (const b of bs) {
    x = Math.min(x, b.x, b.x + b.width); y = Math.min(y, b.y, b.y + b.height)
    right = Math.max(right, b.x, b.x + b.width); bottom = Math.max(bottom, b.y, b.y + b.height)
  }
  return { x, y, width: right - x, height: bottom - y }
}
