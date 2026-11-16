import type { Bounds, DesignDocument, DesignNode } from './model'

export type SketchFrameDistance = {
  frameId: string
  /** Translation from the layer's parent space into the frame's space. */
  offsetX: number
  offsetY: number
}

/** An ordinary group with a pure translation. Rotated, scaled, flipped,
 * Graphic, mask, instance, boolean, and flow containers keep their own axes. */
export function translatedGroupOffset(group: DesignNode): { x: number; y: number } | undefined {
  if (group.kind !== 'group' || group.graphic || group.repeat || group.booleanOperation || group.instance || group.mask) return
  if (group.layout && group.layout.mode !== 'none') return
  const [a, b, c, d, x, y] = group.transform
  if (a !== 1 || b !== 0 || c !== 0 || d !== 1) return
  return { x, y }
}

/** Figma walks ordinary translated groups up to, but not through, a frame.
 * Groups that are not on a frame still contribute. A blocking container
 * returns a zero offset instead of a partial sum. */
export function figmaPositionOffset(doc: DesignDocument, id: string, parents: ReadonlyMap<string, string>) {
  let x = 0, y = 0
  for (let parent = parents.get(id); parent !== undefined; parent = parents.get(parent)) {
    const group = doc.nodes[parent]
    if (!group || group.kind === 'frame' || group.kind === 'section') break
    const step = translatedGroupOffset(group)
    if (!step) return { x: 0, y: 0 }
    x += step.x
    y += step.y
  }
  return { x, y }
}

/** Sketch edge distances use the nearest frame or section. Ordinary translated
 * groups between the layer and that frame are added. A blocking container, or
 * no frame at all, keeps the immediate parent coordinates. */
export function sketchFrameDistance(doc: DesignDocument, id: string, parents: ReadonlyMap<string, string>): SketchFrameDistance | undefined {
  let offsetX = 0, offsetY = 0
  for (let parent = parents.get(id); parent !== undefined; parent = parents.get(parent)) {
    const group = doc.nodes[parent]
    if (!group) return
    if (group.kind === 'frame' || group.kind === 'section') return { frameId: group.id, offsetX, offsetY }
    const step = translatedGroupOffset(group)
    if (!step) return
    offsetX += step.x
    offsetY += step.y
  }
}

export function sketchFrameEdges(box: Bounds, distance: SketchFrameDistance, frame: { width: number; height: number }) {
  const left = box.x + distance.offsetX
  const top = box.y + distance.offsetY
  return {
    left,
    top,
    right: frame.width - left - box.width,
    bottom: frame.height - top - box.height,
  }
}

/** Display-unit value for `setNodePosition`. Right and bottom move the layer
 * without changing its size. `box` is the parent-space bounds. */
export function frameEdgeDisplayLocal(
  edge: 'left' | 'top' | 'right' | 'bottom',
  displayValue: number,
  box: Bounds,
  distance: SketchFrameDistance,
  frame: { width: number; height: number },
  scaleX: number,
  scaleY: number,
): { axis: 'x' | 'y'; displayLocal: number } {
  if (!Number.isFinite(displayValue) || !Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0)
    throw new Error('图层位置必须为有限数值')
  const horizontal = edge === 'left' || edge === 'right'
  const scale = horizontal ? scaleX : scaleY
  const span = horizontal ? box.width : box.height
  const frameSize = horizontal ? frame.width : frame.height
  const offset = horizontal ? distance.offsetX : distance.offsetY
  const displayedEdge = edge === 'left' || edge === 'top'
    ? displayValue
    : frameSize * scale - displayValue - span * scale
  return { axis: horizontal ? 'x' : 'y', displayLocal: displayedEdge - offset * scale }
}

/** Pin controls for a layer whose frame is an ancestor, not the direct parent.
 * Direct children keep the existing frame/section rule. Graphic frames and
 * flowed children without absolute positioning do not gain a second entry. */
export function sketchNestedFramePins(doc: DesignDocument, id: string, parents: ReadonlyMap<string, string>): boolean {
  const distance = sketchFrameDistance(doc, id, parents)
  if (!distance || parents.get(id) === distance.frameId) return false
  const frame = doc.nodes[distance.frameId]
  const node = doc.nodes[id]
  if (!frame || frame.graphic || !node) return false
  const flow = !!frame.layout && frame.layout.mode !== 'none'
  return !flow || !!node.sizing?.absolute
}
