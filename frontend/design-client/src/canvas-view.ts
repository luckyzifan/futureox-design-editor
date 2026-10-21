import type { Bounds, DesignDocument, DesignNode, Matrix, Point } from './model'
import { apply, around, inverse, multiply, rotate, boxPoints, bounds } from './geometry'
import { kernelSnapPoint, kernelBounds } from './kernel/picking'
export { zoomAt } from './canvas-camera'

export function localBounds(n: DesignNode): Bounds {
  return ((n.network || n.textPath || n.pathOffset) ? kernelBounds(n) : null) || { x: 0, y: 0, width: n.width, height: n.height }
}
/** A group's authored width can be stale after editing its descendants. Measure
 * children in the group's own axes instead of rotating a world AABB twice. */
export function selectionLocalBounds(doc: DesignDocument, id: string): Bounds {
  const n=doc.nodes[id]
  if(n.kind!=='group')return localBounds(n)
  const points=n.children.filter(id=>doc.nodes[id]?.visible).flatMap(id=>{
    const child=doc.nodes[id]
    return boxPoints(selectionLocalBounds(doc,id)).map(p=>apply(child.transform,p))
  })
  return points.length?bounds(points):localBounds(n)
}
/** Inspector/scale bounds only. An empty group falls back to its authored box.
 * Optional transform lets an edit use its draft transform with snapshot children. */
export function selectionParentBounds(doc: DesignDocument, id: string, transform: Matrix = doc.nodes[id].transform): Bounds {
  return bounds(boxPoints(selectionLocalBounds(doc, id)).map(point => apply(transform, point)))
}
export function parentBounds(n: DesignNode): Bounds {
  return bounds(boxPoints(localBounds(n)).map((p) => apply(n.transform, p)))
}
export function rotationDegrees(n: DesignNode) {
  return (-Math.atan2(n.transform[1], n.transform[0]) * 180) / Math.PI
}
export function rotateNode(n: DesignNode, degrees: number, b = localBounds(n)) {
  const center = apply(n.transform, { x: b.x + b.width / 2, y: b.y + b.height / 2 })
  n.transform = multiply(around(center, rotate(rotationDegrees(n) - degrees)), n.transform)
}
export const forcedPixelSnap = (n: DesignNode) =>
  ['frame', 'section'].includes(n.kind) || !!n.component || !!n.instance || !!n.componentSet
export function snapMove(
  box: Bounds,
  delta: Point,
  enabled: boolean,
  axes = { x: true, y: true },
): Point {
  if (!enabled) return delta
  const p = kernelSnapPoint({ x: box.x + delta.x, y: box.y + delta.y })
  return { x: axes.x ? p.x - box.x : delta.x, y: axes.y ? p.y - box.y : delta.y }
}
export function createBox(a: Point, b: Point, snap: boolean): Bounds {
  if (snap) {
    a = kernelSnapPoint(a)
    b = kernelSnapPoint(b)
  }
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  }
}
export function resizeInBasis(
  basis: Matrix,
  box: Bounds,
  start: Point,
  end: Point,
  corner: number,
  aspect: boolean,
  center: boolean,
  snap: boolean,
): Matrix {
  const inv = inverse(basis),
    a = apply(inv, start),
    b = apply(inv, end)
  const corners = [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ]
  const edge = corner >= 4 ? corner - 4 : -1
  const opposite = edge >= 0 ? (edge + 2) % 4 : -1
  const anchor = center
    ? { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    : edge >= 0 ? { x: (corners[opposite].x + corners[(opposite+1)%4].x)/2, y: (corners[opposite].y + corners[(opposite+1)%4].y)/2 }
    : corners[(corner + 2) % 4]
  const horizontal = edge < 0 || edge % 2 === 1, vertical = edge < 0 || edge % 2 === 0
  let sx = horizontal && box.width > 1e-10 ? (b.x - anchor.x) / (a.x - anchor.x || 1) : 1,
    sy = vertical && box.height > 1e-10 ? (b.y - anchor.y) / (a.y - anchor.y || 1) : 1
  sx = Math.max(0.01, sx)
  sy = Math.max(0.01, sy)
  if (aspect) {
    sx = sy = edge >= 0 ? (horizontal ? sx : sy) : Math.max(sx, sy)
  }
  if (snap) {
    const size = kernelSnapPoint({ x: box.width * sx, y: box.height * sy })
    if (aspect) {
      const factor =
        box.width >= box.height
          ? Math.max(1, size.x) / Math.max(box.width, 1e-10)
          : Math.max(1, size.y) / Math.max(box.height, 1e-10)
      sx = sy = factor
    } else {
      if (horizontal && box.width > 1e-10) sx = Math.max(1, size.x) / box.width
      if (vertical && box.height > 1e-10) sy = Math.max(1, size.y) / box.height
    }
  }
  return multiply(basis, multiply(around(anchor, [sx, 0, 0, sy, 0, 0]), inv))
}
