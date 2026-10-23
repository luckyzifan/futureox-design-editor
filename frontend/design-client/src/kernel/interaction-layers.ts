import type { PoseActionToken } from './pose-action-correlation'
import type { InteractionPreviewFailure } from './interaction-preview-recovery'
import { effectsAreKnown } from './render-dependency'
import type { Bounds, DesignDocument, Matrix } from '../model'
import { scene, unionBounds, multiply, inverse } from '../geometry'
import type { CanvasCamera } from '../canvas-camera'
import type { RefObject } from 'react'
import type { CanvasSceneBorrow } from '../canvas-scene-snapshots'

export type InteractionLayer = { document: DesignDocument; bounds: Bounds; moving?: string }
export type InteractionPlan = { document: DesignDocument; pageId: string; ids: string[]; layers: InteractionLayer[]; viewport?: Bounds }
export type InteractionPoseFeedback = { x: number; y: number; matrix?: Matrix }
export type GpuMoveControl = {
  isActive(): boolean
  apply(document: DesignDocument, patches: Record<string, Partial<DesignDocument['nodes'][string]>>, trace?: PoseActionToken): InteractionPoseFeedback | null
  covers(document: DesignDocument, ids: string[], view: CanvasCamera): boolean
  feedbackPending?(): boolean
  inputSequence?(): number
  previewFailure?(): number
  end(document: DesignDocument): void
}
export type InteractionProps = {
  /** Canvas gesture semantics; affine edits must not be rebound to a translation-only owner. */
  gestureKind?: string
  document: DesignDocument; selection: string[]; active: boolean; epoch: number; control: RefObject<GpuMoveControl | null>; onReady: () => void
  /** Optional Canvas-only published geometry. Other callers remain uncached. */
  onPreviewFailed?: (failure: InteractionPreviewFailure) => void
  onPosePresented?: (pose: { sequence: number; offset: InteractionPoseFeedback; latencyMs: number; document: DesignDocument; epoch: number }) => void
  scene?: CanvasSceneBorrow
}

/** Only backdrop reads outside an isolated root propagate damage between
 * boards. Internal background blurs move with their containing board. */
export function pageBackdropPadding(document:DesignDocument,entries:readonly ReturnType<typeof scene>[number][]):number {
  return entries.reduce((sum,entry)=>{
    if(entry.ancestors.some(id=>document.nodes[id]?.blend!=='pass-through'))return sum
    const scale=Math.max(Math.hypot(entry.matrix[0],entry.matrix[1]),Math.hypot(entry.matrix[2],entry.matrix[3]))
    return sum+document.nodes[entry.id].effects.filter(effect=>effect.visible&&['background-blur','glass'].includes(effect.kind))
      .reduce((n,effect)=>{
        // Match the kernel's conservative material support, including glass
        // distortion with zero frost. Radius alone misses refracted neighbours.
        const g=effect.glass
        const material=g?Math.max(g.depth,g.bevelSize??1)*(1+(g.refraction+g.dispersion*.125)*2)
          :effect.kind==='glass'?Math.abs(effect.amount)*2:0
        return n+(effect.radius*3+material)*scale
      },0)
  },0)
}

/** Normal page roots are isolated by the existing kernel compositor. Their
 * children (including internal blur/masks/CSG/layout) therefore remain intact
 * when the entire root is placed elsewhere. Root backdrop reads/pass-through
 * and page masks need dependency rendering and cannot be flattened this way.
 * Stationary intervals preserve ordering for overlapping and multiple roots. */
export function planInteractionLayers(document: DesignDocument, pageId: string, ids: readonly string[], viewport?: Bounds): InteractionPlan | null {
  const page = document.pages.find(page => page.id === pageId)
  if (!page || !ids.length || ids.length > 16 || ids.some(id => !page.children.includes(id))) return null
  const roots = page.children.filter(id => document.nodes[id]?.visible)
  const independent = (id: string): boolean => {
    const n = document.nodes[id]
    if (!n?.visible) return true
    if (!effectsAreKnown(n.effects) || n.mask || n.effects.some(e => e.visible && ['background-blur', 'glass'].includes(e.kind))) return false
    if (n.blend === 'normal') return true
    return n.blend === 'pass-through' && n.opacity === 1 && !n.clip && !n.effects.some(e => e.visible) &&
      [...n.fills, ...n.strokes.filter(s => s.visible).map(s => s.paint)].every(p => !p.visible || p.blend === 'normal') &&
      n.children.every(independent)
  }
  if (roots.some(id => !independent(id))) return null
  const entries = scene(document, pageId)
  if (entries.some(entry => !effectsAreKnown(document.nodes[entry.id].effects))) return null
  const selected = new Set(ids), layers: InteractionLayer[] = []
  const append = (children: string[], moving?: string) => {
    if (!children.length) return
    const included = new Set(children)
    let bounds = unionBounds(entries.filter(e => included.has(e.id) || e.ancestors.some(id => included.has(id))).map(e => {
      const n = document.nodes[e.id], scale = Math.max(Math.hypot(e.matrix[0], e.matrix[1]), Math.hypot(e.matrix[2], e.matrix[3]))
      const pad = Math.max(0, ...n.strokes.filter(s => s.visible).map(s => s.width * 4),
        ...n.effects.filter(f => f.visible).map(f => f.radius * 3 + Math.abs(f.spread || 0) + Math.abs(f.x || 0) + Math.abs(f.y || 0))) * scale + 2
      return { x: e.bounds.x - pad, y: e.bounds.y - pad, width: e.bounds.width + pad * 2, height: e.bounds.height + pad * 2 }
    }))
    // Stationary content only supplies the visible backdrop. Capturing distant
    // boards wastes warm-up time and dilutes the moving board's pixel budget.
    // The moving layer stays whole so it can follow the pointer into view.
    if (viewport && !moving) {
      const x = Math.max(bounds.x, viewport.x), y = Math.max(bounds.y, viewport.y)
      const right = Math.min(bounds.x + bounds.width, viewport.x + viewport.width)
      const bottom = Math.min(bounds.y + bounds.height, viewport.y + viewport.height)
      if (right <= x || bottom <= y) return
      bounds = { x, y, width: right - x, height: bottom - y }
    }
    // Keep every authored node reachable for kernel validation and component
    // dependencies. Hide other roots instead of orphaning their subtrees by
    // deleting page edges (which fails on real multi-board documents).
    layers.push({ moving, bounds, document: { ...document, nodes: { ...document.nodes,
      ...Object.fromEntries(page.children.filter(id => !included.has(id)).map(id => [id, { ...document.nodes[id], visible: false }])),
    } } })
  }
  let stationary: string[] = []
  for (const id of roots) {
    if (selected.has(id)) { append(stationary); stationary = []; append([id], id) }
    else stationary.push(id)
  }
  append(stationary)
  return { document, pageId, ids: [...ids], layers, viewport }
}

/** A translation preserves the cached pixels; changing derived content or
 * ancestry revokes the plan even if the document id stayed the same. */
export function interactionOffsets(plan: InteractionPlan, current: DesignDocument): Map<string, { x: number; y: number }> | null {
  const source = plan.document
  // The plan captures this exact snapshot. A camera/ACK layout pass may build
  // a new plan without changing authored content; enumerating every node to
  // discover zero movement blocks the same thread that accepts the next input.
  // Do not cache arbitrary document objects here: a different snapshot still
  // needs the complete content/ancestry validation below.
  if (current === source) return new Map(plan.ids.filter(id => Object.hasOwn(source.nodes, id))
    .map(id => [id, { x: 0, y: 0 }]))
  if (Object.keys(current).some(key => key !== 'nodes' && current[key as keyof DesignDocument] !== source[key as keyof DesignDocument]) ||
      Object.keys(current.nodes).length !== Object.keys(source.nodes).length) return null
  const moved = new Set(plan.ids), offsets = new Map<string, { x: number; y: number }>()
  for (const [id, node] of Object.entries(current.nodes)) {
    const old = source.nodes[id]
    if (!old) return null
    if (node !== old && (!moved.has(id) || Object.keys(node).length !== Object.keys(old).length ||
      Object.keys(node).some(key => key !== 'transform' && node[key as keyof typeof node] !== old[key as keyof typeof old]) ||
      node.transform.slice(0, 4).some((v, i) => v !== old.transform[i]))) return null
    if (moved.has(id)) offsets.set(id, { x: node.transform[4] - old.transform[4], y: node.transform[5] - old.transform[5] })
  }
  return offsets
}

export function interactionPatchedDocument(document: DesignDocument, patches: Record<string, { transform?: Matrix }>) {
  return { ...document, nodes: { ...document.nodes,
    ...Object.fromEntries(Object.entries(patches).map(([id, patch]) => [id, { ...document.nodes[id], ...patch }])) } }
}

/** An affine edit (rotation/scale) has no translation offsets to reuse, but
 * when only selected transforms differ from the plan snapshot the last
 * completed capture is still the structurally valid pose: it may stay
 * presented until exact tiles for the committed document replace it. */
export function interactionTransformsOnly(plan: InteractionPlan, current: DesignDocument): boolean {
  const source = plan.document
  if (current === source) return true
  if (Object.keys(current).some(key => key !== 'nodes' && current[key as keyof DesignDocument] !== source[key as keyof DesignDocument]) ||
      Object.keys(current.nodes).length !== Object.keys(source.nodes).length) return false
  const moved = new Set(plan.ids)
  for (const [id, node] of Object.entries(current.nodes)) {
    const old = source.nodes[id]
    if (!old) return false
    if (node !== old && (!moved.has(id) || Object.keys(node).length !== Object.keys(old).length ||
        Object.keys(node).some(key => key !== 'transform' && node[key as keyof typeof node] !== old[key as keyof typeof old]))) return false
  }
  return true
}

/** Pointer translation validates selected transforms instead of enumerating
 * the whole unchanged document for every input event. */
export function interactionPatchedOffsets(plan: InteractionPlan, document: DesignDocument,
  patches: Record<string, Partial<DesignDocument['nodes'][string]>>, validated?: Map<string,{x:number;y:number}> | null) {
  const base = validated === undefined ? document === plan.document ? new Map(plan.ids.map(id => [id, { x: 0, y: 0 }])) : interactionOffsets(plan, document) : validated
  const offsets = base ? new Map(base) : null
  if (!offsets || Object.keys(patches).some(id => !plan.ids.includes(id))) return null
  for (const id of plan.ids) {
    const patch = patches[id], before = plan.document.nodes[id].transform, after = patch?.transform || document.nodes[id].transform
    if (patch && Object.keys(patch).some(key => key !== 'transform') || after.length !== 6 ||
        !after.every(Number.isFinite) || after.slice(0, 4).some((value, i) => value !== before[i])) return null
    offsets.set(id, { x: after[4] - before[4], y: after[5] - before[5] })
  }
  return offsets
}

/** Validate absolute selected poses without weakening the retained-bitmap
 * translation contract. Affine poses always go through a fresh kernel render. */
export function interactionPatchedTransforms(plan: InteractionPlan, document: DesignDocument,
  patches: Record<string, Partial<DesignDocument['nodes'][string]>>, validated = false): Record<string, Matrix> | null {
  if (!validated && !interactionTransformsOnly(plan, document) ||
      Object.keys(patches).some(id => !plan.ids.includes(id))) return null
  const transforms: Record<string, Matrix> = {}
  for (const id of plan.ids) {
    const patch = patches[id], transform = patch?.transform || document.nodes[id]?.transform
    if (patch && Object.keys(patch).some(key => key !== 'transform') || !transform ||
        transform.length !== 6 || !transform.every(Number.isFinite)) return null
    transforms[id] = [...transform] as Matrix
  }
  return transforms
}

/** World-space chrome correction from the authored overlay to one rendered
 * absolute pose. Parent matrices are immutable for this transforms-only lease. */
export function interactionPoseMatrices(before: Record<string, Matrix>, after: Record<string, Matrix>,
  parents?: ReadonlyMap<string, Matrix>): Map<string, Matrix> | null {
  const result = new Map<string, Matrix>()
  for (const [id, transform] of Object.entries(after)) {
    const source = before[id], parent = parents?.get(id) || [1, 0, 0, 1, 0, 0] as Matrix
    if (!source) return null
    const world = multiply(parent, source)
    if (Math.abs(world[0] * world[3] - world[1] * world[2]) < 1e-12) return null
    const delta = multiply(multiply(parent, transform), inverse(world))
    if (!delta.every(Number.isFinite)) return null
    result.set(id, delta)
  }
  return result
}

/** Conservative UI admission. Derived/layout-dependent affine edits continue
 * through Editor.preview; native repeats its own authoritative proof. */
export function interactionAffineEligible(plan: InteractionPlan): boolean {
  const document = plan.document, nodes = Object.values(document.nodes)
  if (document.animations?.length || nodes.some(node => node.repeat || node.connector)) return false
  const parents = new Map<string, string>()
  for (const node of nodes) for (const child of node.children) parents.set(child, node.id)
  const selected = new Set(plan.ids)
  for (const id of selected) {
    let current: string | undefined = id
    while (current) {
      const node = document.nodes[current]
      if (!node || node.instance || node.instanceOrigin || node.component || node.componentSet || node.componentKey ||
          node.booleanOperation || Object.keys(node.bindings || {}).length || Object.keys(node.variableModes || {}).length ||
          Object.keys(node.styleRefs || {}).length || node.constraints ||
          current !== id && (selected.has(current) || node.layout && node.layout.mode !== 'none' ||
            node.sizing?.width === 'hug' || node.sizing?.height === 'hug')) return false
      current = parents.get(current)
    }
  }
  return true
}
