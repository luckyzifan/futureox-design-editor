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

export class SelectionScaleError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'SelectionScaleError' }
}
const rejectScale = (code: string, message: string): never => { throw new SelectionScaleError(code, message) }
/** Shared UI/automation command planning. The caller owns the isolated draft,
 * publication, permissions and history; this function performs no mutation. */
export function prepareSelectionScale(doc: DesignDocument, pageId: string, selected: readonly string[], factor: number, anchor = 4,
  state: { fresh: boolean } = { fresh: true }): { ids: string[]; transforms: Record<string, Matrix> } {
  if (!selected.length || selected.length !== new Set(selected).size) rejectScale('invalid_params', 'Select distinct node identifiers')
  if (!Number.isFinite(factor) || factor < .01 || factor > 1e4 || !Number.isInteger(anchor) || anchor < 0 || anchor > 8)
    rejectScale('invalid_params', 'Scale factor must be 0.01–10000 and anchor must be an integer 0–8')
  const parents = allParents(doc), chosen = new Set(selected), ids: string[] = []
  const derived = (id: string) => {
    const n = doc.nodes[id]
    return !!(n.booleanOperation || n.instance || n.instanceOrigin || n.component || n.componentSet ||
      n.kind === 'text' || n.textPath || n.connector || n.board || (n.layout && n.layout.mode !== 'none') ||
      n.bindings || n.styleRefs || n.variableModes || n.constraints ||
      (n.sizing && (n.sizing.width !== 'fixed' || n.sizing.height !== 'fixed')))
  }
  for (const id of selected) {
    if (!Object.hasOwn(doc.nodes, id)) rejectScale('not_found', 'A selected node no longer exists')
    let at: string | undefined = id, nested = false
    while (at && doc.nodes[at]) {
      const n = doc.nodes[at]
      if (!n.visible) rejectScale('invalid_selection', 'Hidden scale targets or hidden ancestors are not supported; show the full selection first')
      if (n.locked) rejectScale('locked_node', 'Selection or an ancestor is locked')
      if (n.instanceOrigin || (at !== id && n.instance)) rejectScale('instance_structure', 'Layers nested inside component instances cannot be scaled')
      if (!state.fresh && derived(at)) rejectScale('unsupported_derived_batch_geometry', 'Commit preceding edits before scaling derived geometry')
      if (at !== id && chosen.has(at)) nested = true
      at = parents.get(at)
    }
    if (at !== pageId) rejectScale('different_pages', 'Scale targets must belong to the active page')
    if (!nested) ids.push(id)
  }
  const visited = new Set<string>(), stack = [...ids]
  while (!state.fresh && stack.length) {
    const id = stack.pop()!
    if (visited.has(id)) continue
    visited.add(id)
    if (derived(id)) rejectScale('unsupported_derived_batch_geometry', 'Commit preceding edits before scaling derived geometry')
    for (const child of doc.nodes[id].children) stack.push(child)
  }
  for (const id of ids) {
    const n = doc.nodes[id], parent = doc.nodes[parents.get(id)!]
    if (parent?.layout && parent.layout.mode !== 'none' && !n.sizing?.absolute)
      rejectScale('auto_layout_position', 'Scale of auto-layout flow children requires a layout-aware command')
  }
  try {
    const frame = selectionScaleFrame(doc, pageId, ids)
    if (![frame.box.x, frame.box.y, frame.width, frame.height].every(Number.isFinite))
      rejectScale('geometry_unavailable', 'Scale bounds must be finite')
    const transforms = scaleSelectionTransforms(doc, ids, factor, scaleAnchor(frame, anchor))
    if (Object.values(transforms).some(matrix => !matrix.every(Number.isFinite)))
      rejectScale('unsupported_transform', 'Scale transform must be finite')
    return { ids, transforms: factor === 1 ? {} : transforms }
  } catch (error) {
    if (error instanceof SelectionScaleError) throw error
    return rejectScale('unsupported_transform', error instanceof Error ? error.message : String(error))
  }
}
