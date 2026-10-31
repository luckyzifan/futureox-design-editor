import type { Bounds, DesignDocument, Matrix } from './model'
import { intersects, scene, unionBounds } from './geometry'

/** Only isolated page roots may be lifted out of a completed frame. A crop
 * cannot reconstruct content hidden underneath an overlapping board. */
export function retainedBoardPlan(document: DesignDocument, pageId: string, selection: string[]) {
  const page = document.pages.find(p => p.id === pageId)
  if (!page || selection.length !== 1 || !page.children.includes(selection[0])) return null
  const id = selection[0], root = document.nodes[id]
  if (!root?.visible || root.mask || root.opacity !== 1 || !['normal', 'pass-through'].includes(root.blend)) return null
  const entries = scene(document, pageId)
  // Each entry belongs to exactly one page root. Re-filtering the complete
  // scene for every root makes warm-up quadratic on large flat documents.
  const rootBounds = new Map<string, Bounds>()
  for (const e of entries) {
    const n = document.nodes[e.id], scale = Math.max(Math.hypot(e.matrix[0], e.matrix[1]), Math.hypot(e.matrix[2], e.matrix[3]))
    const pad = Math.max(0, ...n.strokes.filter(s => s.visible).map(s => s.width * 4),
      ...n.effects.filter(f => f.visible).map(f => f.radius * 3 + Math.abs(f.spread || 0) + Math.abs(f.x || 0) + Math.abs(f.y || 0))) * scale
    const b = e.bounds
    const padded = { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 }
    const rootId = e.ancestors[0] || e.id, previous = rootBounds.get(rootId)
    rootBounds.set(rootId, previous ? unionBounds([previous, padded]) : padded)
  }
  const box = rootBounds.get(id)
  if (!box) return null
  const others = page.children.filter(other => other !== id && document.nodes[other]?.visible)
    .map(other => rootBounds.get(other)).filter((box): box is Bounds => !!box)
  if (others.some(other => intersects(box, other))) return null
  return { id, source: document, matrix: root.transform, box, others }
}

export function retainedBoardOffset(plan: NonNullable<ReturnType<typeof retainedBoardPlan>>, document: DesignDocument) {
  if (document === plan.source) return retainedBoardTransformOffset(plan, document.nodes[plan.id].transform)
  if (Object.keys(document).length !== Object.keys(plan.source).length ||
      Object.keys(document).some(key => key !== 'nodes' && document[key as keyof DesignDocument] !== plan.source[key as keyof DesignDocument]) ||
      Object.keys(document.nodes).length !== Object.keys(plan.source.nodes).length) return null
  for (const [id, node] of Object.entries(document.nodes)) {
    const previous = plan.source.nodes[id]
    if (node === previous) continue
    if (id !== plan.id || !previous || Object.keys(node).length !== Object.keys(previous).length ||
        Object.keys(node).some(k => k !== 'transform' && node[k as keyof typeof node] !== previous[k as keyof typeof previous])) return null
    if (node.transform.slice(0, 4).some((v, i) => v !== previous.transform[i])) return null
  }
  return retainedBoardTransformOffset(plan, document.nodes[plan.id].transform)
}

/** After validating an immutable source document once, pointer events only
 * change this root transform. Avoid cloning/scanning the entire node map. */
export function retainedBoardTransformOffset(plan: NonNullable<ReturnType<typeof retainedBoardPlan>>, current: Matrix) {
  if (current.length !== 6 || !current.every(Number.isFinite) || current.slice(0, 4).some((value, index) => value !== plan.matrix[index])) return null
  const offset = { x: current[4] - plan.matrix[4], y: current[5] - plan.matrix[5] }
  const movedBox = { ...plan.box, x: plan.box.x + offset.x, y: plan.box.y + offset.y }
  if (plan.others.some(other => intersects(movedBox, other))) return null
  return offset
}

// Keep capture independently testable without booting the geometry/WASM engine.
export { captureBoardFrame } from './retained-board-capture'
