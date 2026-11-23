import type { Bounds, DesignDocument, Matrix, Point } from './model'
import { apply, boxPoints } from './geometry'
import { selectionLocalBounds } from './canvas-view'
import { normalizeDegrees } from './selection-handles'

const SKEW = 1e-4

export type SharedRotationFrame = { corners: Point[]; basis: Matrix; box: Bounds }

function rotationHundredths(matrix: Matrix): number | null {
  const xLen = Math.hypot(matrix[0], matrix[1])
  const yLen = Math.hypot(matrix[2], matrix[3])
  if (!(xLen > 1e-8) || !(yLen > 1e-8)) return null
  const dot = (matrix[0] * matrix[2] + matrix[1] * matrix[3]) / (xLen * yLen)
  if (Math.abs(dot) > SKEW) return null
  let hundredths = Math.round(normalizeDegrees(Math.atan2(matrix[1], matrix[0]) * 180 / Math.PI) * 100) / 100
  if (hundredths === 180) hundredths = -180
  return Object.is(hundredths, -0) ? 0 : hundredths
}

/** 0/90/180 already produce a page-aligned rectangle. Keep the scene union for
 * those so handle order on an axis-aligned selection does not move. */
function pageAligned(hundredths: number) {
  const turn = Math.abs(hundredths)
  return turn === 0 || turn === 90 || turn === 180
}

/** Local geometric box in `matrix` space. Curves use kernel extrema. Groups
 * remeasure children, including after their authored width goes stale. */
export function selectionMemberCorners(doc: DesignDocument, id: string, matrix: Matrix): Point[] | null {
  const node = doc.nodes[id]
  if (!node || !matrix?.every(Number.isFinite)) return null
  const local = selectionLocalBounds(doc, id)
  if (![local.x, local.y, local.width, local.height].every(Number.isFinite)) return null
  return boxPoints(local).map(point => apply(matrix, point))
}

/** Tight box along one shared orthogonal rotation. Mixed angles, skew, and
 * page-aligned rotations return null so the caller keeps the scene union. */
export function sharedRotationFrame(members: readonly { matrix: Matrix; corners: readonly Point[] }[]): SharedRotationFrame | null {
  if (members.length < 2) return null
  const angles = members.map(member => rotationHundredths(member.matrix))
  const angle = angles[0]
  if (angle === null || pageAligned(angle) || angles.some(value => value !== angle)) return null
  const xLen = Math.hypot(members[0].matrix[0], members[0].matrix[1])
  const yLen = Math.hypot(members[0].matrix[2], members[0].matrix[3])
  const ux = members[0].matrix[0] / xLen
  const uy = members[0].matrix[1] / xLen
  const vx = members[0].matrix[2] / yLen
  const vy = members[0].matrix[3] / yLen
  let minS = Infinity, minT = Infinity, maxS = -Infinity, maxT = -Infinity
  for (const member of members) {
    if (!member.corners.length) return null
    for (const point of member.corners) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null
      const s = point.x * ux + point.y * uy
      const t = point.x * vx + point.y * vy
      if (s < minS) minS = s
      if (t < minT) minT = t
      if (s > maxS) maxS = s
      if (t > maxT) maxT = t
    }
  }
  const basis: Matrix = [ux, uy, vx, vy, 0, 0]
  const box: Bounds = { x: minS, y: minT, width: maxS - minS, height: maxT - minT }
  return { basis, box, corners: boxPoints(box).map(point => apply(basis, point)) }
}
