import type { Bounds, DesignDocument, DesignNode, Matrix } from './model'
import { unionBounds } from './commands/affine'
import { gestureHoleColor, visibleFollowBox, type FollowCamera } from './gesture-follow-frame'

export type RotationSnapshotEntry = {
  id: string
  matrix: Matrix
  bounds: Bounds
  ancestors: readonly string[]
}

export type RotationSnapshotPlan = {
  id: string
  source: DesignDocument
  matrix: Matrix
  box: Bounds
  others: Bounds[]
  hole: string
}

/** Nodes painted after the selection. A rectangular lift can include them;
 * content already behind an opaque layer stays in the untouched screenshot. */
function paintedInFront(document: DesignDocument, pageId: string, id: string, ancestors: readonly string[]): Set<string> | null {
  const page = document.pages.find(item => item.id === pageId)
  if (!page) return null
  const chain = [...ancestors, id]
  const front = new Set<string>()
  const mark = (at: string) => {
    const node = document.nodes[at]
    if (!node?.visible || front.has(at)) return
    front.add(at)
    for (const child of node.children) mark(child)
  }
  let children = page.children
  for (const at of chain) {
    const index = children.indexOf(at)
    if (index < 0) return null
    for (const sibling of children.slice(index + 1)) mark(sibling)
    if (at === id) return front
    children = document.nodes[at]?.children || []
  }
  return null
}

function paddedEntry(document: DesignDocument, entry: RotationSnapshotEntry): Bounds | null {
  const node = document.nodes[entry.id]
  if (!node) return null
  const scale = Math.max(Math.hypot(entry.matrix[0], entry.matrix[1]), Math.hypot(entry.matrix[2], entry.matrix[3]))
  const pad = Math.max(0,
    ...node.strokes.filter(stroke => stroke.visible).map(stroke => stroke.width * 4),
    ...node.effects.filter(effect => effect.visible).map(effect =>
      effect.radius * 3 + Math.abs(effect.spread || 0) + Math.abs(effect.x || 0) + Math.abs(effect.y || 0))) * scale
  return {
    x: entry.bounds.x - pad, y: entry.bounds.y - pad,
    width: entry.bounds.width + pad * 2, height: entry.bounds.height + pad * 2,
  }
}

function canLift(node: DesignNode | undefined): node is DesignNode {
  return !!node?.visible && !node.mask && node.kind !== 'slice' && node.opacity === 1 &&
    (node.blend === 'normal' || node.blend === 'pass-through')
}

/** One selected layer, including a large image nested in a frame. The whole
 * page does not have to be effect-free: the screenshot already baked those
 * pixels. Overlap is tested only against paint in front of this layer. */
export function rotationSnapshotPlan(
  document: DesignDocument,
  pageId: string,
  id: string,
  entries: readonly RotationSnapshotEntry[],
): RotationSnapshotPlan | null {
  const node = document.nodes[id]
  const entry = entries.find(item => item.id === id)
  if (!canLift(node) || !entry) return null
  const subtree = new Set<string>([id])
  for (const item of entries) if (item.ancestors.includes(id)) subtree.add(item.id)
  const front = paintedInFront(document, pageId, id, entry.ancestors)
  if (!front) return null
  let box: Bounds | null = null
  const others: Bounds[] = []
  for (const item of entries) {
    if (subtree.has(item.id)) {
      const padded = paddedEntry(document, item)
      if (!padded) return null
      box = box ? unionBounds([box, padded]) : padded
      continue
    }
    if (!front.has(item.id) || item.bounds.width <= 0 || item.bounds.height <= 0) continue
    others.push(item.bounds)
  }
  if (!box || !(box.width > 0) || !(box.height > 0) || ![box.x, box.y, box.width, box.height].every(Number.isFinite)) return null
  const parentId = entry.ancestors.at(-1)
  const parent = parentId ? document.nodes[parentId] : undefined
  return { id, source: document, matrix: entry.matrix, box, others, hole: gestureHoleColor(document, pageId, parent) }
}

function overlaps(a: Bounds, b: Bounds) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/** Keep a fully visible crop. A large image that crosses the canvas edge lifts
 * only the visible part. Paint already in front of that part still refuses. */
export function rotationSnapshotCrop(
  box: Bounds,
  others: readonly Bounds[],
  view: FollowCamera,
  delta: Matrix,
  width: number,
  height: number,
): Bounds | undefined {
  const determinant = delta[0] * delta[3] - delta[1] * delta[2]
  if (delta.length !== 6 || !delta.every(Number.isFinite) || !Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return
  const fitted = (candidate: Bounds) => {
    if (view.zoom <= 0 || width <= 0 || height <= 0) return
    const margin = 2 / view.zoom
    const crop = { x: candidate.x - margin, y: candidate.y - margin, width: candidate.width + margin * 2, height: candidate.height + margin * 2 }
    if (crop.x * view.zoom + view.x < 0 || crop.y * view.zoom + view.y < 0 ||
        (crop.x + crop.width) * view.zoom + view.x > width || (crop.y + crop.height) * view.zoom + view.y > height) return
    if (others.some(other => overlaps(crop, other))) return
    return candidate
  }
  const exact = fitted(box)
  if (exact) return exact
  const visible = visibleFollowBox(box, view, width, height)
  return visible ? fitted(visible) : undefined
}

/** The lifted pixels and their outline are the preview. Publishing the
 * document on every sample holds the selection to the old texture instead. */
export function rotationSnapshotOwnsPreview(kind: string | undefined, layer: { holding: boolean } | null | undefined) {
  return kind === 'rotate' && !!layer && !layer.holding
}
