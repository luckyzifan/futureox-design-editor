import { screenToWorld, type CanvasCamera, type CanvasSize } from './canvas-camera'
import { canvasDropFrame } from './canvas-drop'
import { apply, inverse, multiply, worldMatrix } from './geometry'
import type { DesignDocument, DesignNode, Point } from './model'
import { createShapeSeed, resolveShapeCreation, type ShapeCreationKind } from './shape-creation'

/** Single-click Figma objects. Lines, vector paths, connectors, and tables
 * need more than one point, so Return does not insert them. */
const KEYBOARD_PLACE_TOOLS: readonly ShapeCreationKind[] = [
  'frame', 'section', 'rectangle', 'ellipse', 'polygon', 'star', 'text',
]

export function keyboardPlacesTool(tool: string): tool is ShapeCreationKind {
  return (KEYBOARD_PLACE_TOOLS as readonly string[]).includes(tool)
}

/** The keyboard crosshair starts in the middle of the viewport.
 * Figma's accessibility guide says arrow keys reveal it there, and the
 * August 2025 keyboard note says Enter places text in the center of the screen.
 * Arrow-key movement of that crosshair is a separate gesture. */
export function keyboardPlacementPoint(view: CanvasCamera, size: CanvasSize): Point {
  if (!(size.width > 0) || !(size.height > 0) || !(view.zoom > 0) ||
      ![view.x, view.y, view.zoom, size.width, size.height].every(Number.isFinite))
    throw new Error('Invalid placement viewport')
  return screenToWorld(view, { x: size.width / 2, y: size.height / 2 })
}

/** A Return insertion uses the click-sized object, centered on the crosshair.
 * That is the same geometry as Alt-click, so the default 100×100 sits on the
 * viewport center instead of hanging off its top-left. */
export function keyboardPlacedNode(tool: ShapeCreationKind, point: Point, snap: boolean): DesignNode {
  const place = (useSnap: boolean) => resolveShapeCreation(createShapeSeed(tool), {
    anchor: point, pointer: point, screenDistance: 0, alt: true, snap: useSnap,
  }).node
  if (!snap) return place(false)
  try {
    return place(true)
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('尚未就绪')) throw error
    return place(false)
  }
}

/** Same parent drop as a click release: the object's center joins the frame under it. */
export function insertKeyboardPlacedNode(document: DesignDocument, pageId: string, node: DesignNode) {
  if (node.graphic && document.schemaVersion < 23) document.schemaVersion = 23
  document.nodes[node.id] = node
  const page = document.pages.find(entry => entry.id === pageId)
  if (!page) throw new Error('页面不存在')
  page.children.push(node.id)
  if (node.kind === 'slice') return
  let parent: string | undefined
  try {
    const center = apply(node.transform, { x: node.width / 2, y: node.height / 2 })
    parent = canvasDropFrame(document, page.id, [node.id], center, false)
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('尚未就绪')) throw error
    return
  }
  if (!parent) return
  const index = page.children.indexOf(node.id)
  if (index < 0) return
  page.children.splice(index, 1)
  document.nodes[parent].children.push(node.id)
  document.nodes[node.id].transform = multiply(inverse(worldMatrix(document, parent)), node.transform)
}
