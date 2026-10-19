import type { DesignDocument } from './model'
import { allParents, worldMatrix } from './geometry'
import { imageAdjustActive } from './kernel/gpu/image-adjust'

/** Only the existing vector presentation's supported subset can supply live
 * editing pixels. Exact GPU/CPU output remains authoritative after settling. */
export function supportsEditPreview(doc: DesignDocument, pageId?: string): boolean {
  // Scene uses SVG's sRGB paint/filter/blend semantics and never applies the
  // document's working-space/HDR policy. Keep managed edits on their renderer.
  if (doc.colorManagement) return false
  // Only the displayed page can affect this preview. Hidden ancestors also
  // hide their descendants; unrelated pages must not disable a local gesture.
  const nodes: DesignDocument['nodes'][string][] = []
  const seen = new Set<string>()
  const visit = (id: string) => {
    const n = doc.nodes[id]
    if (!n?.visible || seen.has(id)) return
    seen.add(id); nodes.push(n); n.children.forEach(visit)
  }
  for (const page of doc.pages) if (!pageId || page.id === pageId) page.children.forEach(visit)
  return nodes.length <= 5000 && nodes.every(n => !n.visible || (
    !['linear-burn', 'linear-dodge'].includes(n.blend) &&
    n.effects.every(e => !e.visible || (!e.gradientBlur && ['blur', 'shadow', 'inner-shadow', 'background-blur'].includes(e.kind))) &&
    [...n.fills, ...n.strokes.filter(s => s.visible).map(s => s.paint)].every(p => !p.visible || (
      ['solid', 'linear', 'radial', 'image'].includes(p.kind) &&
      !['linear-burn', 'linear-dodge'].includes(p.blend) &&
      // SVG Color has no color-managed adjustment or pattern-addressing
      // implementation. Keep the exact/retained pixels rather than dropping
      // authored parameters for the duration of a drag.
      (p.kind !== 'image' || (!imageAdjustActive(p.adjust) && (!p.tile || p.tile.mode === 'none') && !p.transform))
    ))
  ))
}

/** A retained SVG definition can translate without reconstructing the React
 * document. Backdrop effects embed world-space captures, and derived layout
 * or boolean geometry must keep the regular transactional preview. */
export function retainedSvgMove(document: DesignDocument, pageId: string, ids: readonly string[]) {
  if (ids.length !== 1 || !supportsEditPreview(document, pageId)) return null
  const id = ids[0], root = document.nodes[id]
  if (!root?.visible || root.mask || root.kind === 'slice') return null
  const parents = allParents(document)
  for (let at: string | undefined = id; at && at !== pageId; at = parents.get(at)) {
    const n = document.nodes[at]
    if (!n || n.booleanOperation || n.instance || n.instanceOrigin || n.component || n.componentSet ||
      (n.layout && n.layout.mode !== 'none') || Object.keys(n.bindings || {}).length || Object.keys(n.variableModes || {}).length) return null
  }
  // Only a backdrop INSIDE the moved subtree changes its world-to-local
  // capture transform. Stationary backdrops reference the retained visual
  // definition and follow it automatically (Scene keeps that capture source).
  const pending = [id], seen = new Set<string>()
  while (pending.length) {
    const at = pending.pop()!, n = document.nodes[at]
    if (!n?.visible || seen.has(at)) continue
    seen.add(at)
    if (n.effects.some(e => e.visible && ['background-blur', 'glass'].includes(e.kind))) return null
    pending.push(...n.children)
  }
  return { id, source: document, matrix: worldMatrix(document, id, parents),
    parentMatrix: worldMatrix(document, parents.get(id)!, parents) }
}

export function movePreviewPlan(document: DesignDocument, pageId: string, ids: readonly string[]) {
  if (ids.length !== 1) return null
  const id = ids[0], root = document.nodes[id], page = document.pages.find(p => p.id === pageId)
  if (!root || !page || root.mask || !root.visible || !['normal', 'pass-through'].includes(root.blend)) return null
  const parents = allParents(document)
  // A separated topmost subtree cannot cover siblings that should be above it.
  // Ancestor clips/effects/opacity and backdrop-dependent subtrees stay on the
  // full live scene; their compositing cannot be split into independent layers.
  for (let at = id; at !== pageId;) {
    const parentId = parents.get(at), parent = document.nodes[parentId || '']
    const siblings = parent?.children || page.children
    if ([...siblings].reverse().find(child => document.nodes[child]?.visible) !== at) return null
    if (!parentId) return null
    if (parent && (parent.clip || parent.mask || parent.booleanOperation || parent.children.some(child => document.nodes[child]?.visible && document.nodes[child]?.mask) || parent.opacity !== 1 || parent.effects.some(e => e.visible) ||
      !['normal', 'pass-through'].includes(parent.blend))) return null
    at = parentId
  }
  const subtree: DesignDocument['nodes'] = {}
  const collect = (child: string): boolean => {
    const n = document.nodes[child]
    if (!['normal', 'pass-through'].includes(n.blend) || [...n.fills, ...n.strokes.map(s => s.paint)].some(p => p.visible && p.blend !== 'normal')) return false
    if (n.effects.some(e => e.visible && ['background-blur', 'glass'].includes(e.kind))) return false
    subtree[child] = n
    return n.children.every(collect)
  }
  if (!collect(id)) return null
  const matrix = worldMatrix(document, id, parents)
  subtree[id] = { ...root, transform: matrix }
  return { id, matrix, source: document,
    background: { ...document, nodes: { ...document.nodes, [id]: { ...root, visible: false } } },
    foreground: { ...document, pages: [{ ...page, children: [id] }], nodes: subtree },
  }
}

export function movePreviewOffset(plan: NonNullable<ReturnType<typeof movePreviewPlan>>, document: DesignDocument) {
  const source = plan.source, id = plan.id
  if (document.pages !== source.pages || document.fonts !== source.fonts || document.designSystem !== source.designSystem ||
    Object.keys(document.nodes).length !== Object.keys(source.nodes).length) return null
  for (const [key, node] of Object.entries(document.nodes)) {
    if (node === source.nodes[key]) continue
    if (key !== id || !source.nodes[key]) return null
    const old = source.nodes[key]
    if (Object.keys(node).some(k => k !== 'transform' && node[k as keyof typeof node] !== old[k as keyof typeof old])) return null
    if (node.transform.slice(0, 4).some((v, i) => v !== old.transform[i])) return null
  }
  const matrix = worldMatrix(document, id)
  return { x: matrix[4] - plan.matrix[4], y: matrix[5] - plan.matrix[5] }
}
