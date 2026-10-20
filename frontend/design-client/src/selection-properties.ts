import { defaultSizing, defaultTextStyle, type DesignDocument, type DesignNode, type Matrix } from './model'
import { localBounds, parentBounds, rotationDegrees } from './canvas-view'
import { propertyUnits, type PropertyUnits } from './property-units'
import { multiply } from './geometry'

export function commonValue<T>(values: T[]): T | undefined {
  return values.length && values.every((value) => Object.is(value, values[0])) ? values[0] : undefined
}
export type SelectionMetric = 'x' | 'y' | 'width' | 'height' | 'rotation' | 'opacity'
export function selectionMetric(node: DesignNode, field: SelectionMetric, doc?: DesignDocument, resolvedUnits?: PropertyUnits): number {
  if (field === 'rotation') return rotationDegrees(node)
  if (field === 'opacity') return node.opacity * 100
  const units = resolvedUnits ?? (doc ? propertyUnits(doc, node.id) : { parentX: 1, parentY: 1, width: 1, height: 1 })
  if (field === 'x' || field === 'y') return parentBounds(node)[field] * (field === 'x' ? units.parentX : units.parentY)
  const bounds = localBounds(node)
  return field === 'width'
    ? bounds.width * Math.hypot(node.transform[0], node.transform[1]) * units.width
    : bounds.height * Math.hypot(node.transform[2], node.transform[3]) * units.height
}
export function resizeNodeDimension(node: DesignNode, axis: 'width' | 'height', value: number, doc?: DesignDocument, resolvedUnits?: PropertyUnits) {
  const nodeUnits = resolvedUnits ?? (doc ? propertyUnits(doc, node.id) : undefined)
  const units = nodeUnits?.[axis] ?? 1
  const ratio = value / Math.max(1e-10, selectionMetric(node, axis, doc, nodeUnits))
  if (!Number.isFinite(ratio) || ratio <= 0) throw new Error('图层尺寸必须为正数')
  const sx = axis === 'width' || node.constrainProportions ? ratio : 1
  const sy = axis === 'height' || node.constrainProportions ? ratio : 1
  const box = localBounds(node)
  const next = multiply(node.transform, [sx, 0, 0, sy, box.x * (1 - sx), box.y * (1 - sy)])
  Object.assign(node, resizedNode(node, next, node.constrainProportions ? ['width', 'height'] : [axis]))
  // Explicit values must not acquire oldSize*(newSize/oldSize) rounding;
  // otherwise equal batch edits can incorrectly display as mixed values.
  if (node.kind !== 'group' && !node.network) {
    const scale = axis === 'width' ? Math.hypot(node.transform[0], node.transform[1]) : Math.hypot(node.transform[2], node.transform[3])
    node[axis] = value / (units * scale)
  }
}

/** One resize contract for canvas handles and Inspector dimensions. Groups
 * derive their bounds from children, so their transform owns the resize.
 * Text changes its fixed layout box; only the Scale tool stretches glyphs. */
export function resizedNode(source: DesignNode, transform: Matrix, editedAxes?: readonly ('width' | 'height')[]): Partial<DesignNode> {
  if (source.kind === 'group') return { transform }
  const sx = Math.hypot(transform[0], transform[1]) / Math.hypot(source.transform[0], source.transform[1])
  const sy = Math.hypot(transform[2], transform[3]) / Math.hypot(source.transform[2], source.transform[3])
  if (![sx, sy].every(v => Number.isFinite(v) && v > 0)) throw new Error('图层缩放矩阵无效')
  // Property fields supply the authored axis, including exact-size writes.
  // The existing canvas contract remains dual-axis until gesture intent is
  // passed explicitly by the caller; matrix deltas cannot determine intent.
  const axes = editedAxes ?? ['width', 'height'] as const
  const sizing = { ...defaultSizing(), ...source.sizing }
  for (const axis of axes) sizing[axis] = 'fixed'
  const point = (p: { x: number; y: number }) => ({ x: p.x * sx, y: p.y * sy })
  return {
    transform: [transform[0] / sx, transform[1] / sx, transform[2] / sy, transform[3] / sy, transform[4], transform[5]],
    width: source.width * sx, height: source.height * sy,
    ...(source.network ? { network: { ...source.network,
      vertices: source.network.vertices.map(v => ({ ...v, ...point(v) })),
      edges: source.network.edges.map(e => ({ ...e, ...(e.c1 ? { c1: point(e.c1) } : {}), ...(e.c2 ? { c2: point(e.c2) } : {}) })),
    } } : {}),
    ...(source.sizing || source.kind === 'text' ? { sizing } : {}),
    ...(source.kind === 'text' ? { textStyle: { ...defaultTextStyle(), ...source.textStyle, wrap: true } } : {}),
  }
}
