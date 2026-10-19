// Independent test construction for the saturated Figma corner: a circle's
// standard four cubic quarters. Uses the sqrt(2) identity and Bernstein basis,
// not the production trigonometric corner builder or adaptive subdivision.
import type { DesignNode, Network, Point } from './model'

const k = (4 * (Math.sqrt(2) - 1)) / 3
export function cornerPoint(radius: number, t = 0.25) {
  const points = [
    { x: radius, y: 0 },
    { x: radius * (1 + k), y: 0 },
    { x: 2 * radius, y: radius * (1 - k) },
    { x: 2 * radius, y: radius },
  ]
  const weights = [(1 - t) ** 3, 3 * t * (1 - t) ** 2, 3 * t * t * (1 - t), t ** 3]
  const p = { x: 0, y: 0 },
    tangent = { x: 0, y: 0 }
  for (let i = 0; i < 4; i++) {
    p.x += points[i].x * weights[i]
    p.y += points[i].y * weights[i]
  }
  const derivative = [3 * (1 - t) ** 2, 6 * t * (1 - t), 3 * t * t]
  for (let i = 0; i < 3; i++) {
    tangent.x += (points[i + 1].x - points[i].x) * derivative[i]
    tangent.y += (points[i + 1].y - points[i].y) * derivative[i]
  }
  const length = Math.hypot(tangent.x, tangent.y)
  const normal = { x: tangent.y / length, y: -tangent.x / length }
  return {
    point: p,
    normal,
    offset: (distance: number): Point => ({
      x: p.x + normal.x * distance,
      y: p.y + normal.y * distance,
    }),
  }
}

export function cubicCircleReference(n: DesignNode, radius: number): DesignNode {
  const points = [
    { x: radius, y: 0 },
    { x: 2 * radius, y: radius },
    { x: radius, y: 2 * radius },
    { x: 0, y: radius },
  ]
  const tangent = [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: -1, y: 0 },
    { x: 0, y: -1 },
  ]
  const network: Network = {
    vertices: points.map((p, i) => ({ id: `v${i}`, ...p })),
    edges: points.map((p, i) => {
      const j = (i + 1) % 4
      return {
        id: `e${i}`,
        from: `v${i}`,
        to: `v${j}`,
        c1: { x: p.x + tangent[i].x * k * radius, y: p.y + tangent[i].y * k * radius },
        c2: {
          x: points[j].x - tangent[j].x * k * radius,
          y: points[j].y - tangent[j].y * k * radius,
        },
      }
    }),
    fillRule: 'nonzero',
  }
  return { ...n, kind: 'vector', network }
}
