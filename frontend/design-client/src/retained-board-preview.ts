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
  const branchBounds = (rootId: string): Bounds => unionBounds(entries.filter(e => e.id === rootId || e.ancestors.includes(rootId)).map(e => {
    const n = document.nodes[e.id], scale = Math.max(Math.hypot(e.matrix[0], e.matrix[1]), Math.hypot(e.matrix[2], e.matrix[3]))
    const pad = Math.max(0, ...n.strokes.filter(s => s.visible).map(s => s.width * 4),
      ...n.effects.filter(f => f.visible).map(f => f.radius * 3 + Math.abs(f.spread || 0) + Math.abs(f.x || 0) + Math.abs(f.y || 0))) * scale
    const b = e.bounds
    return { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 }
  }))
  const box = branchBounds(id)
  const others = page.children.filter(other => other !== id && document.nodes[other]?.visible).map(branchBounds)
  if (others.some(other => intersects(box, other))) return null
  return { id, source: document, matrix: root.transform, box, others }
}

export function retainedBoardOffset(plan: NonNullable<ReturnType<typeof retainedBoardPlan>>, document: DesignDocument) {
  if (document.pages !== plan.source.pages || document.fonts !== plan.source.fonts || document.designSystem !== plan.source.designSystem ||
      Object.keys(document.nodes).length !== Object.keys(plan.source.nodes).length) return null
  for (const [id, node] of Object.entries(document.nodes)) {
    const previous = plan.source.nodes[id]
    if (node === previous) continue
    if (id !== plan.id || !previous || Object.keys(node).some(k => k !== 'transform' && node[k as keyof typeof node] !== previous[k as keyof typeof previous])) return null
    if (node.transform.slice(0, 4).some((v, i) => v !== previous.transform[i])) return null
  }
  const current: Matrix = document.nodes[plan.id].transform
  const offset = { x: current[4] - plan.matrix[4], y: current[5] - plan.matrix[5] }
  if (plan.others.some(other => intersects({ ...plan.box, x: plan.box.x + offset.x, y: plan.box.y + offset.y }, other))) return null
  return offset
}

/** Snapshot only the published display canvases, in their compositor order.
 * Bounded to two viewport surfaces; no GPU readback or authored-data change. */
export function captureBoardFrame(host: HTMLElement, box: Bounds, view: {x:number;y:number;zoom:number}) {
  const presentation = host.querySelector('.kernel-presentation[data-presentation-ready="true"]')
  if (!presentation) { host.dataset.boardCapture = 'not-ready'; return null }
  const hostBox = host.getBoundingClientRect(), scale = Math.min(2, window.devicePixelRatio || 1)
  const crop = { x: Math.floor(box.x * view.zoom + view.x) - 2, y: Math.floor(box.y * view.zoom + view.y) - 2,
    width: Math.ceil(box.width * view.zoom) + 4, height: Math.ceil(box.height * view.zoom) + 4 }
  if (crop.x < 0 || crop.y < 0 || crop.x + crop.width > hostBox.width || crop.y + crop.height > hostBox.height ||
      hostBox.width * hostBox.height * scale * scale > 8_388_608) { host.dataset.boardCapture = `clipped:${JSON.stringify({crop,host:{width:hostBox.width,height:hostBox.height}})}`; return null }
  const background = document.createElement('canvas'), foreground = document.createElement('canvas')
  background.width = Math.ceil(hostBox.width * scale); background.height = Math.ceil(hostBox.height * scale)
  foreground.width = Math.ceil(crop.width * scale); foreground.height = Math.ceil(crop.height * scale)
  const back = background.getContext('2d'), front = foreground.getContext('2d')
  if (!back || !front) return null
  back.scale(scale, scale)
  const canvases = Array.from(presentation.querySelectorAll('canvas')).filter(canvas => {
    const style = getComputedStyle(canvas)
    return canvas.width > 0 && canvas.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && canvas.getAttribute('aria-hidden') !== 'true'
  }).sort((a,b) => (Number(getComputedStyle(a).zIndex) || 0) - (Number(getComputedStyle(b).zIndex) || 0))
  if (!canvases.length) { host.dataset.boardCapture = 'empty'; return null }
  for (const canvas of canvases) {
    const r = canvas.getBoundingClientRect()
    back.drawImage(canvas, r.x - hostBox.x, r.y - hostBox.y, r.width, r.height)
  }
  front.drawImage(background, crop.x * scale, crop.y * scale, crop.width * scale, crop.height * scale, 0, 0, foreground.width, foreground.height)
  back.clearRect(crop.x, crop.y, crop.width, crop.height)
  host.dataset.boardCapture = 'captured'
  return { background, foreground, crop, width: hostBox.width, height: hostBox.height }
}
