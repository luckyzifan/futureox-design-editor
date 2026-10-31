import type { PoseActionToken } from './pose-action-correlation'
import type { InteractionPreviewFailure } from './interaction-preview-recovery'
import { effectsAreKnown } from './render-dependency'
import type { Bounds, DesignDocument, Matrix } from '../model'
import { scene, multiply, inverse, type SceneEntry } from '../geometry'
import type { CanvasCamera } from '../canvas-camera'
import type { RefObject } from 'react'
import type { CanvasSceneBorrow } from '../canvas-scene-snapshots'
import { documentTransitionNodeIds } from '../document-patch'

export type InteractionLayer = { document: DesignDocument; roots: string[]; bounds: Bounds; moving?: string }
export type InteractionPlan = { document: DesignDocument; pageId: string; ids: string[]; layers: InteractionLayer[]; viewport?: Bounds; parentLinear?: Map<string, number[]> }
export type InteractionPoseFeedback = { x: number; y: number; matrix?: Matrix }
export type InteractionInput = { sequence:number; at:number; guides?:readonly import('./gpu/canvas-overlay').CanvasGuide[] }
export type GpuMoveControl = {
  isActive(): boolean
  /** Private complete-layer authority; structural eligibility alone is not
   * enough to suspend an ordinary viewport repair. */
  blocksCanvasRefinement?(document:DesignDocument,ids:string[],view:CanvasCamera):boolean
  apply(document: DesignDocument, patches: Record<string, Partial<DesignDocument['nodes'][string]>>, trace?: PoseActionToken, guides?:InteractionInput['guides']): InteractionPoseFeedback | null
  /** Guides are drawn with the sampled pixels, outside the content backbuffer. */
  guidesInSurface?(): boolean
  covers(document: DesignDocument, ids: string[], view: CanvasCamera): boolean
  feedbackPending?(): boolean
  inputSequence?(): number
  previewFailure?(): number
  end(document: DesignDocument): void
}
export type InteractionProps = {
  readinessRevision?:number
  /** Optional selection warming yields to the current camera's visible work. */
  navigating?:boolean
  /** Canvas gesture semantics; affine edits must not be rebound to a translation-only owner. */
  gestureKind?: string
  document: DesignDocument; selection: string[]; active: boolean; epoch: number; control: RefObject<GpuMoveControl | null>; onReady: () => void
  /** Optional Canvas-only published geometry. Other callers remain uncached. */
  onPreviewFailed?: (failure: InteractionPreviewFailure) => void
  onPosePresented?: (pose: { sequence: number; offset: InteractionPoseFeedback; latencyMs: number; document: DesignDocument; epoch: number; control?:GpuMoveControl }) => void
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

type InteractionPlanOptions = { neutralPageGroup?: boolean; scene?: CanvasSceneBorrow; epoch?: number }

/** One derived structure per renderer, valid only while Canvas still lends the
 * exact immutable publication. Do not retain scene entries or cache mutable
 * standalone callers. Camera changes only clip the stationary intervals. */
export class InteractionLayerPlanner {
  private cached?: { document: DesignDocument; pageId: string; ids: string[];
    borrow: CanvasSceneBorrow; epoch: number; neutral: boolean; plan: InteractionPlan | null }

  clear() { this.cached = undefined }

  plan(document: DesignDocument, pageId: string, ids: readonly string[], viewport?: Bounds, options?: InteractionPlanOptions) {
    const entries = options?.epoch === undefined ? undefined : options.scene?.entriesFor(document, pageId, options.epoch)
    if (!entries) {
      this.clear()
      return planInteractionLayers(document, pageId, ids, viewport, options)
    }
    const cached = this.cached, neutral = !!options?.neutralPageGroup
    if (!cached || cached.document !== document || cached.pageId !== pageId || cached.borrow !== options!.scene ||
        cached.epoch !== options!.epoch || cached.neutral !== neutral || cached.ids.length !== ids.length ||
        cached.ids.some((id, index) => id !== ids[index])) {
      this.cached = { document, pageId, ids: [...ids], borrow: options!.scene!, epoch: options!.epoch!, neutral,
        plan: buildInteractionLayers(document, pageId, ids, options, entries) }
    }
    return clipInteractionLayers(this.cached!.plan, viewport)
  }
}

function clipInteractionLayers(plan: InteractionPlan | null, viewport?: Bounds): InteractionPlan | null {
  if (!plan) return null
  const layers: InteractionLayer[] = []
  for (const layer of plan.layers) {
    let bounds = layer.bounds
    // Moving content stays whole; only stationary backdrop is viewport bound.
    if (viewport && !layer.moving) {
      const x = Math.max(bounds.x, viewport.x), y = Math.max(bounds.y, viewport.y)
      const right = Math.min(bounds.x + bounds.width, viewport.x + viewport.width)
      const bottom = Math.min(bounds.y + bounds.height, viewport.y + viewport.height)
      if (right <= x || bottom <= y) continue
      bounds = { x, y, width: right - x, height: bottom - y }
    }
    layers.push({ ...layer, bounds })
  }
  return { ...plan, layers, viewport }
}

/** Normal page roots are isolated by the existing kernel compositor. Their
 * children (including internal blur/masks/CSG/layout) therefore remain intact
 * when the entire root is placed elsewhere. Root backdrop reads/pass-through
 * and page masks need dependency rendering and cannot be flattened this way.
 * Stationary intervals preserve ordering for overlapping and multiple roots. */
export function planInteractionLayers(document: DesignDocument, pageId: string, ids: readonly string[], viewport?: Bounds,
  options?: InteractionPlanOptions): InteractionPlan | null {
  const entries = options?.epoch === undefined ? undefined : options.scene?.entriesFor(document, pageId, options.epoch)
  return clipInteractionLayers(buildInteractionLayers(document, pageId, ids, options, entries), viewport)
}

function buildInteractionLayers(document: DesignDocument, pageId: string, ids: readonly string[],
  options?: InteractionPlanOptions, publishedEntries?: readonly SceneEntry[]): InteractionPlan | null {
  const page = document.pages.find(page => page.id === pageId)
  if (!page || !ids.length || ids.length > 16 || new Set(ids).size !== ids.length) return null
  const selectedIds = new Set(ids), ancestors = new Set<string>(), pageRoots = new Set(page.children)
  const parents = new Map<string, string>()
  // Root selections need no parent table. Nested published selections borrow
  // their existing ancestor chains instead of enumerating every page's nodes.
  if (ids.some(id => !pageRoots.has(id))) {
    if (publishedEntries) {
      for (const entry of publishedEntries) if (selectedIds.has(entry.id)) {
        let child = entry.id
        for (let i = entry.ancestors.length - 1; i >= 0; i--) {
          parents.set(child, entry.ancestors[i]); child = entry.ancestors[i]
        }
      }
    } else for (const n of Object.values(document.nodes)) for (const id of n.children) parents.set(id, n.id)
  }
  for (const id of ids) {
    if (!document.nodes[id]?.visible) return null
    let at=id
    while (!pageRoots.has(at)) {
      const parent=parents.get(at), n=parent ? document.nodes[parent] : undefined
      // A sole, empty normal page group has no outside painter inside its
      // isolation. Split its children into the same independently captured
      // intervals as page roots, only after every child passes independent()
      // below. Painted/clipped/effect/layout groups retain the live compiler.
      const neutralPageGroup=options?.neutralPageGroup&&n?.kind==='group'&&n.blend==='normal'&&
        page.children.length===1&&page.children[0]===n.id
      if (!n || selectedIds.has(n.id) || n.blend!=='pass-through'&&!neutralPageGroup || n.opacity!==1 || n.clip || n.mask ||
          n.fills.some(p=>p.visible) || n.strokes.some(p=>p.visible) || n.effects.some(e=>e.visible) ||
          n.layout || n.sizing || n.constraints || n.booleanOperation || n.instance || n.instanceOrigin || n.component || n.componentSet || n.repeat ||
          Object.keys(n.bindings||{}).length || Object.keys(n.variableModes||{}).length) return null
      ancestors.add(n.id);at=n.id
    }
  }
  const roots: string[]=[]
  const appendRoots=(ids:readonly string[])=>{ for(const id of ids) {
    const n=document.nodes[id];if(!n?.visible)continue
    if(ancestors.has(id))appendRoots(n.children);else roots.push(id)
  }}
  appendRoots(page.children)
  if (ids.some(id=>!roots.includes(id))) return null
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
  // Camera changes need new capture bounds, not a second layout of Canvas's
  // immutable publication. A revoked/missing borrow retains the uncached path.
  const entries = publishedEntries ?? scene(document, pageId)
  const layers: InteractionLayer[] = [], layerForRoot = new Map<string, number>()
  const append = (children: string[], moving?: string) => {
    if (!children.length) return
    for (const id of children) layerForRoot.set(id, layers.length)
    // Rust applies this render-only scope through its existing COW snapshot.
    // Keep the original object identity so the interaction lane can borrow its
    // acknowledged source, without cloning/serializing the complete node table.
    layers.push({ moving, bounds: { x: 0, y: 0, width: 0, height: 0 }, document, roots: [...children] })
  }
  let stationary: string[] = []
  for (const id of roots) {
    if (selectedIds.has(id)) { append(stationary); stationary = []; append([id], id) }
    else stationary.push(id)
  }
  append(stationary)
  const extents = layers.map(() => ({ x: Infinity, y: Infinity, right: -Infinity, bottom: -Infinity, count: 0 }))
  const parentIds = new Set(parents.values()), parentMatrices = new Map<string, number[]>()
  // Check all visible effects, including descendants of isolated roots, while
  // accumulating each entry exactly once in its painter interval. Preserve
  // unionBounds' original padded-edge arithmetic (no repeated pairwise union).
  for (const e of entries) {
    const n = document.nodes[e.id]
    if (!effectsAreKnown(n.effects)) return null
    if (parentIds.has(e.id)) parentMatrices.set(e.id, e.matrix.slice(0, 4))
    let index = layerForRoot.get(e.id)
    if (index === undefined) for (const id of e.ancestors) {
      index = layerForRoot.get(id)
      if (index !== undefined) break
    }
    if (index === undefined) continue
    const scale = Math.max(Math.hypot(e.matrix[0], e.matrix[1]), Math.hypot(e.matrix[2], e.matrix[3]))
    const pad = Math.max(0, ...n.strokes.filter(s => s.visible).map(s => s.width * 4),
      ...n.effects.filter(f => f.visible).map(f => f.radius * 3 + Math.abs(f.spread || 0) + Math.abs(f.x || 0) + Math.abs(f.y || 0))) * scale + 2
    const x = e.bounds.x - pad, y = e.bounds.y - pad, width = e.bounds.width + pad * 2, height = e.bounds.height + pad * 2
    const b = extents[index]
    b.x = Math.min(b.x, x, x + width); b.y = Math.min(b.y, y, y + height)
    b.right = Math.max(b.right, x, x + width); b.bottom = Math.max(b.bottom, y, y + height); b.count++
  }
  layers.forEach((layer, index) => {
    const b = extents[index]
    if (b.count) layer.bounds = { x: b.x, y: b.y, width: b.right - b.x, height: b.bottom - b.y }
  })
  const parentLinear = new Map(ids.map(id => [id, parentMatrices.get(parents.get(id) || '') || [1, 0, 0, 1]]))
  return { document, pageId, ids: [...ids], layers, parentLinear }
}

/** A translation preserves the cached pixels; changing derived content or
 * ancestry revokes the plan even if the document id stayed the same. */
export function interactionOffsets(plan: InteractionPlan, current: DesignDocument): Map<string, { x: number; y: number }> | null {
  const source = plan.document
  // The plan captures this exact snapshot. A camera/ACK layout pass may build
  // a new plan without changing authored content; enumerating every node to
  // discover zero movement blocks the same thread that accepts the next input.
  // Only a complete authored producer witness may narrow the checks below.
  // Unknown snapshots and mutable drafts retain the full node comparison.
  if (current === source) return new Map(plan.ids.filter(id => Object.hasOwn(source.nodes, id))
    .map(id => [id, { x: 0, y: 0 }]))
  if (Object.keys(current).length !== Object.keys(source).length ||
      Object.keys(current).some(key => key !== 'nodes' && current[key as keyof DesignDocument] !== source[key as keyof DesignDocument])) return null
  const changed = documentTransitionNodeIds(source, current)
  if (!changed && Object.keys(current.nodes).length !== Object.keys(source.nodes).length) return null
  const moved = new Set(plan.ids), offsets = new Map<string, { x: number; y: number }>(
    changed ? plan.ids.filter(id => Object.hasOwn(source.nodes, id)).map(id => [id, { x: 0, y: 0 }]) : [])
  for (const [id, node] of changed ? [...changed].map(id => [id, current.nodes[id]] as const) : Object.entries(current.nodes)) {
    const old = source.nodes[id]
    if (!old || !node) return null
    if (node !== old && (!moved.has(id) || Object.keys(node).length !== Object.keys(old).length ||
      Object.keys(node).some(key => key !== 'transform' && node[key as keyof typeof node] !== old[key as keyof typeof old]) ||
      node.transform.slice(0, 4).some((v, i) => v !== old.transform[i]))) return null
    if (moved.has(id)) offsets.set(id, { x: node.transform[4] - old.transform[4], y: node.transform[5] - old.transform[5] })
  }
  return offsets
}

export { interactionPatchedDocument } from './interaction-document-source'

/** An affine edit (rotation/scale) has no translation offsets to reuse, but
 * when only selected transforms differ from the plan snapshot the last
 * completed capture is still the structurally valid pose: it may stay
 * presented until exact tiles for the committed document replace it. */
export function interactionTransformsOnly(plan: InteractionPlan, current: DesignDocument): boolean {
  const source = plan.document
  if (current === source) return true
  if (Object.keys(current).length !== Object.keys(source).length ||
      Object.keys(current).some(key => key !== 'nodes' && current[key as keyof DesignDocument] !== source[key as keyof DesignDocument])) return false
  const changed = documentTransitionNodeIds(source, current)
  if (!changed && Object.keys(current.nodes).length !== Object.keys(source.nodes).length) return false
  const moved = new Set(plan.ids)
  for (const [id, node] of changed ? [...changed].map(id => [id, current.nodes[id]] as const) : Object.entries(current.nodes)) {
    const old = source.nodes[id]
    if (!old || !node) return false
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
