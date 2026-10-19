import type { Bounds, DesignDocument, Matrix, Point } from './model'
import { allParents, apply, around, inverse, multiply, scene, unionBounds, worldMatrix } from './geometry'
import { selectionLocalBounds } from './canvas-view'
import { numericExpression } from './numeric-expression'

export function scaleInputFactor(value: string, dimension?: number): number {
  const factor = dimension === undefined ? numericExpression(value.trim().replace(/x$/i, ''), 1)
    : numericExpression(value, dimension) / dimension
  if (!Number.isFinite(factor) || factor < .01 || factor > 1e4) throw Error('缩放倍率应在 0.01 到 10000 之间')
  return factor
}

export type ScaleFrame = { box: Bounds; basis: Matrix; width: number; height: number }
export function selectionScaleFrame(doc: DesignDocument, page: string, ids: string[]): ScaleFrame {
  if (ids.length === 1 && doc.nodes[ids[0]]) {
    const n = doc.nodes[ids[0]], box = selectionLocalBounds(doc,n.id), basis = worldMatrix(doc, n.id)
    return { box, basis, width: box.width * Math.hypot(basis[0], basis[1]), height: box.height * Math.hypot(basis[2], basis[3]) }
  }
  const selected = new Set(ids), box = unionBounds(scene(doc, page).filter(e => selected.has(e.id)).map(e => e.bounds))
  return { box, basis: [1, 0, 0, 1, 0, 0], width: box.width, height: box.height }
}
export function scaleAnchor(frame: ScaleFrame, anchor: number): Point {
  if (!Number.isInteger(anchor) || anchor < 0 || anchor > 8) throw Error('缩放锚点无效')
  return apply(frame.basis, { x: frame.box.x + frame.box.width * (anchor % 3) / 2, y: frame.box.y + frame.box.height * Math.floor(anchor / 3) / 2 })
}
/** Keep the similarity in native transforms. This scales children, text, paints,
 * strokes and material distances through the existing Rust/GPU contracts, with
 * no path flattening, raster resampling or independently rounded style edits. */
export function scaleSelectionTransforms(doc: DesignDocument, ids: string[], factor: number, anchor: Point): Record<string, Matrix> {
  if (!Number.isFinite(factor) || factor < .01 || factor > 1e4) throw Error('缩放倍率应在 0.01 到 10000 之间')
  if (![anchor.x, anchor.y].every(Number.isFinite)) throw Error('缩放锚点无效')
  const parents = allParents(doc), selected = new Set(ids), transform = around(anchor, [factor, 0, 0, factor, 0, 0])
  const result: Record<string, Matrix> = {}
  for (const id of ids) {
    if (!doc.nodes[id]) throw Error('缩放图层不存在')
    let ancestor: string | undefined = id, nested = false
    while (ancestor && doc.nodes[ancestor]) {
      if (doc.nodes[ancestor].locked) throw Error('请先解锁图层及父级')
      if (ancestor !== id && selected.has(ancestor)) nested = true
      ancestor = parents.get(ancestor)
    }
    if (nested) continue
    const parent = worldMatrix(doc, parents.get(id)!, parents)
    result[id] = factor === 1 ? [...doc.nodes[id].transform] : multiply(inverse(parent), multiply(transform, worldMatrix(doc, id, parents)))
  }
  return result
}
