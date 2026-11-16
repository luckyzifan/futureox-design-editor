import { defaultSizing, defaultTextStyle, type DesignDocument, type DesignNode, type Matrix } from './model'
import { localBounds, parentBounds, selectionLocalBounds, selectionParentBounds } from './canvas-view'
import { figmaRotationDegrees } from './rotation-field'
import { propertyUnits, type PropertyUnits } from './property-units'
import { inverse, multiply } from './geometry'
import { kernelScaleGeometry } from './kernel/picking'
import type { Editor } from './engine'
import { interactivePath } from './selection-hierarchy'

export function commonValue<T>(values: T[]): T | undefined {
  return values.length && values.every((value) => Object.is(value, values[0])) ? values[0] : undefined
}
/** Use live descendant bounds, but the caller's current transform (which may
 * already be an edited draft). Never substitute the snapshot's old transform. */
export function selectionPropertyBounds(node: DesignNode, doc?: DesignDocument) {
  return doc ? selectionParentBounds(doc, node.id, node.transform) : parentBounds(node)
}
/** Figma measures positions through ordinary translated groups up to the
 * containing frame. A transformed/Graphic container keeps its own coordinate
 * system; don't change authored group matrices to make the fields match. */
export function figmaPositionOffset(doc: DesignDocument, id: string, parents: ReadonlyMap<string, string>) {
  let x = 0, y = 0
  for (let parent = parents.get(id); parent !== undefined; parent = parents.get(parent)) {
    const group = doc.nodes[parent]
    if (!group || group.kind === 'frame' || group.kind === 'section') break
    if (group.kind !== 'group' || group.graphic || group.repeat || group.booleanOperation ||
      group.instance || group.mask || (group.layout && group.layout.mode !== 'none')) return { x: 0, y: 0 }
    const [a,b,c,d,dx,dy] = group.transform
    if (a !== 1 || b !== 0 || c !== 0 || d !== 1) return { x: 0, y: 0 }
    x += dx
    y += dy
  }
  return { x, y }
}
/** Handle intent is explicit; a zero movement in one axis of a corner drag
 * still authors both axes. For a world-axis multi-selection edge, map that
 * axis to each node's local dimension directions. */
export function resizeGestureAxes(handle: number, proportional: boolean, world?: Matrix): readonly ('width' | 'height')[] {
  if (handle < 4 || proportional) return ['width', 'height']
  const horizontal = (handle - 4) % 2 === 1
  if (!world) return horizontal ? ['width'] : ['height']
  const component = horizontal ? 0 : 1
  const axes: ('width' | 'height')[] = []
  if (Math.abs(world[component]) > 1e-10 * Math.hypot(world[0], world[1])) axes.push('width')
  if (Math.abs(world[component + 2]) > 1e-10 * Math.hypot(world[2], world[3])) axes.push('height')
  return axes
}
export type SelectionMetric = 'x' | 'y' | 'width' | 'height' | 'rotation' | 'opacity'
export function selectionMetric(node: DesignNode, field: SelectionMetric, doc?: DesignDocument, resolvedUnits?: PropertyUnits): number {
  if (field === 'rotation') return figmaRotationDegrees(node.transform)
  if (field === 'opacity') return node.opacity * 100
  const units = resolvedUnits ?? (doc ? propertyUnits(doc, node.id) : { parentX: 1, parentY: 1, width: 1, height: 1 })
  if (field === 'x' || field === 'y') return (doc ? selectionParentBounds(doc, node.id, node.transform) : parentBounds(node))[field] * (field === 'x' ? units.parentX : units.parentY)
  const bounds = doc ? selectionLocalBounds(doc, node.id) : localBounds(node)
  return field === 'width'
    ? bounds.width * Math.hypot(node.transform[0], node.transform[1]) * units.width
    : bounds.height * Math.hypot(node.transform[2], node.transform[3]) * units.height
}
/** Shared single/multi Inspector position edit, preserving local geometry. */
export function setNodePosition(node: DesignNode, axis: 'x' | 'y', value: number, doc: DesignDocument, resolvedUnits?: PropertyUnits) {
  const units = resolvedUnits ?? propertyUnits(doc, node.id), scale = axis === 'x' ? units.parentX : units.parentY
  if (!Number.isFinite(value) || !Number.isFinite(scale) || scale <= 0) throw new Error('图层位置必须为有限数值')
  node.transform[axis === 'x' ? 4 : 5] += value / scale - selectionParentBounds(doc, node.id, node.transform)[axis]
}
export function resizeNodeDimension(node: DesignNode, axis: 'width' | 'height', value: number, doc?: DesignDocument, resolvedUnits?: PropertyUnits) {
  const nodeUnits = resolvedUnits ?? (doc ? propertyUnits(doc, node.id) : undefined)
  const units = nodeUnits?.[axis] ?? 1
  const ratio = value / Math.max(1e-10, selectionMetric(node, axis, doc, nodeUnits))
  if (!Number.isFinite(ratio) || ratio <= 0) throw new Error('图层尺寸必须为正数')
  const sx = axis === 'width' || node.constrainProportions ? ratio : 1
  const sy = axis === 'height' || node.constrainProportions ? ratio : 1
  const box = doc ? selectionLocalBounds(doc, node.id) : localBounds(node)
  const next = multiply(node.transform, [sx, 0, 0, sy, box.x * (1 - sx), box.y * (1 - sy)])
  Object.assign(node, resizedNode(node, next, node.constrainProportions ? ['width', 'height'] : [axis]))
  // Explicit values must not acquire oldSize*(newSize/oldSize) rounding;
  // otherwise equal batch edits can incorrectly display as mixed values.
  if (node.kind !== 'group' && !node.network && !node.vectorGeometry) {
    const scale = axis === 'width' ? Math.hypot(node.transform[0], node.transform[1]) : Math.hypot(node.transform[2], node.transform[3])
    node[axis] = value / (units * scale)
  }
}

export function editableFrameCrop(editor: Editor): string | undefined {
  const { doc, page, selection } = editor.state
  if (selection.length !== 1) return
  const id = selection[0], frame = doc.nodes[id], parents = editor.parentMap(doc)
  if (!frame || frame.kind !== 'frame' || frame.instance || frame.instanceOrigin ||
      frame.layout && frame.layout.mode !== 'none' || !interactivePath(doc, page, id, false, parents).length) return
  const parent = doc.nodes[parents.get(id) || '']
  if (parent?.layout && parent.layout.mode !== 'none' && !frame.sizing?.absolute) return
  return id
}

/** Resize the frame in its own axes. Rebase direct children so their world
 * transforms and the pin modes used by the next ordinary resize stay intact. */
export function frameCropPatches(doc: DesignDocument, id: string, patch: Partial<DesignNode>): Record<string, Partial<DesignNode>> {
  const frame = doc.nodes[id]
  const width = patch.width ?? frame.width, height = patch.height ?? frame.height
  const transform = patch.transform ?? frame.transform
  const offset = transform.every((value, index) => value === frame.transform[index])
    ? undefined : multiply(inverse(transform), frame.transform)
  const patches: Record<string, Partial<DesignNode>> = { [id]: patch }
  for (const id of frame.children) {
    const child = doc.nodes[id]
    if (offset || child.constraints && (width !== frame.width || height !== frame.height)) {
      patches[id] = {
        ...(offset && { transform: multiply(offset, child.transform) }),
        ...(child.constraints && { constraints: { ...child.constraints, referenceWidth: width, referenceHeight: height } }),
      }
    }
  }
  return patches
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
  // Canvas supplies handle/proportion intent explicitly as well. Legacy callers
  // without an authored axis retain dual-axis semantics.
  const axes = editedAxes ?? ['width', 'height'] as const
  const sizing = { ...defaultSizing(), ...source.sizing }
  for (const axis of axes) sizing[axis] = 'fixed'
  const point = (p: { x: number; y: number }) => ({ x: p.x * sx, y: p.y * sy })
  return {
    transform: [transform[0] / sx, transform[1] / sx, transform[2] / sy, transform[3] / sy, transform[4], transform[5]],
    width: source.width * sx, height: source.height * sy,
    ...(source.vectorGeometry?{vectorGeometry:kernelScaleGeometry(source.vectorGeometry,sx,sy)}:{}),
    ...(source.network ? { network: { ...source.network,
      vertices: source.network.vertices.map(v => ({ ...v, ...point(v) })),
      edges: source.network.edges.map(e => ({ ...e, ...(e.c1 ? { c1: point(e.c1) } : {}), ...(e.c2 ? { c2: point(e.c2) } : {}) })),
    } } : {}),
    ...(source.sizing || source.kind === 'text' ? { sizing } : {}),
    ...(source.kind === 'text' ? { textStyle: { ...defaultTextStyle(), ...source.textStyle, wrap: true } } : {}),
  }
}
