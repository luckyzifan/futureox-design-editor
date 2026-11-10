import type { Bounds, DesignDocument, DesignNode, Matrix } from './model'
import { unionBounds } from './commands/affine'
import { gestureHoleColor, isolatedGestureCrop, visibleFollowBox, type FollowCamera } from './gesture-follow'

export type RotationSnapshotEntry = {
  id: string
  matrix: Matrix
  bounds: Bounds
  ancestors: readonly string[]
}

export type RotationFollowPlan = {
  id: string
  source: DesignDocument
  matrix: Matrix
  box: Bounds
  others: Bounds[]
  hole: string
  /** This plan is a rotation lift. Moves keep the stricter board crop. */
  preview: true
}

/** A lifted screenshot bakes whatever is already in the pixels. Transparency
 * and backdrop reads must stay on the native preview. */
export function rotationLiftEligible(node: DesignNode | undefined): node is DesignNode {
  if (!node?.visible || node.mask || node.kind === 'slice' || node.opacity !== 1) return false
  if (node.blend !== 'normal' && node.blend !== 'pass-through') return false
  if (node.effects.some(effect => effect.visible && (effect.kind === 'background-blur' || effect.kind === 'glass'))) return false
  const paints = [...node.fills, ...node.strokes.filter(stroke => stroke.visible).map(stroke => stroke.paint)]
  if (paints.some(paint => paint.visible && paint.opacity < 1)) return false
  return true
}

function paintedInFront(document: DesignDocument, pageId: string, id: string, ancestors: readonly string[]): Set<string> | null {
  const page = document.pages.find(item => item.id === pageId)
  if (!page) return null
  const front = new Set<string>()
  const mark = (at: string) => {
    const node = document.nodes[at]
    if (!node?.visible || front.has(at)) return
    front.add(at)
    for (const child of node.children) mark(child)
  }
  let children = page.children
  for (const at of [...ancestors, id]) {
    const index = children.indexOf(at)
    if (index < 0) return null
    for (const sibling of children.slice(index + 1)) mark(sibling)
    if (at === id) return front
    children = document.nodes[at]?.children || []
  }
  return null
}

function padded(document: DesignDocument, entry: RotationSnapshotEntry): Bounds | null {
  const node = document.nodes[entry.id]
  if (!node) return null
  const scale = Math.max(Math.hypot(entry.matrix[0], entry.matrix[1]), Math.hypot(entry.matrix[2], entry.matrix[3]))
  const pad = Math.max(0,
    ...node.strokes.filter(stroke => stroke.visible).map(stroke => stroke.width * 4),
    ...node.effects.filter(effect => effect.visible && effect.kind !== 'background-blur' && effect.kind !== 'glass')
      .map(effect => effect.radius * 3 + Math.abs(effect.spread || 0) + Math.abs(effect.x || 0) + Math.abs(effect.y || 0))) * scale
  return {
    x: entry.bounds.x - pad, y: entry.bounds.y - pad,
    width: entry.bounds.width + pad * 2, height: entry.bounds.height + pad * 2,
  }
}

/** One opaque layer, including a large image nested in a frame. Front paint is
 * listed so the same isolation rule can refuse a rotation into it. */
export function rotationFollowPlan(
  document: DesignDocument,
  pageId: string,
  id: string,
  entries: readonly RotationSnapshotEntry[],
): RotationFollowPlan | null {
  const node = document.nodes[id]
  const entry = entries.find(item => item.id === id)
  if (!rotationLiftEligible(node) || !entry) return null
  const subtree = new Set<string>([id])
  for (const item of entries) if (item.ancestors.includes(id)) subtree.add(item.id)
  for (const item of entries) if (subtree.has(item.id) && !rotationLiftEligible(document.nodes[item.id])) return null
  const front = paintedInFront(document, pageId, id, entry.ancestors)
  if (!front) return null
  let box: Bounds | null = null
  const others: Bounds[] = []
  for (const item of entries) {
    if (subtree.has(item.id)) {
      const next = padded(document, item)
      if (!next) return null
      box = box ? unionBounds([box, next]) : next
      continue
    }
    if (!front.has(item.id) || item.bounds.width <= 0 || item.bounds.height <= 0) continue
    others.push(item.bounds)
  }
  if (!box || !(box.width > 0) || !(box.height > 0) || ![box.x, box.y, box.width, box.height].every(Number.isFinite)) return null
  const parentId = entry.ancestors.at(-1)
  return {
    id, source: document, matrix: entry.matrix, box, others, preview: true,
    hole: gestureHoleColor(document, pageId, parentId ? document.nodes[parentId] : undefined),
  }
}

function cropInside(box: Bounds, view: FollowCamera, width: number, height: number) {
  if (view.zoom <= 0 || width <= 0 || height <= 0) return false
  const margin = 2 / view.zoom
  const crop = { x: box.x - margin, y: box.y - margin, width: box.width + margin * 2, height: box.height + margin * 2 }
  return crop.x * view.zoom + view.x >= 0 && crop.y * view.zoom + view.y >= 0 &&
    (crop.x + crop.width) * view.zoom + view.x <= width && (crop.y + crop.height) * view.zoom + view.y <= height
}

/** Lift only a crop isolatedGestureCrop itself accepts, including the rotated
 * destination. A large image may use the visible slice, and that slice is
 * checked with the same function. Backdrop-dependent layers never lift. */
export function rotationPreviewLift(input: {
  node: DesignNode | undefined
  box: Bounds
  others: readonly Bounds[]
  view: FollowCamera
  delta: Matrix
  width: number
  height: number
}): Bounds | undefined {
  if (!rotationLiftEligible(input.node)) return
  const { box, others, view, delta, width, height } = input
  if (cropInside(box, view, width, height)) return isolatedGestureCrop(box, others, view, delta, width, height)
  const visible = visibleFollowBox(box, view, width, height)
  if (!visible) return
  return isolatedGestureCrop(visible, others, view, delta, width, height)
}

/** The lifted rotation is the preview. Publishing every sample holds the
 * selection on the texture that has not moved yet. */
export function rotationLiftOwnsPreview(kind: string | undefined, layer: { holding: boolean } | null | undefined) {
  return kind === 'rotate' && !!layer && !layer.holding
}
