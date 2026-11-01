import { effectsAreKnown } from './render-dependency'
import { allowsReducedSampling } from './render-quality'
import { pageBackdropPadding } from './interaction-layers'
import type { Bounds, DesignDocument, DesignNode, Matrix } from '../model'
import { unionBounds, type SceneEntry } from '../geometry'

/** Keep the existing world-space effect/stroke envelope exactly. Grouping
 * changes only membership lookup, never the arithmetic or union order. */
function paddedBounds(document: DesignDocument, entry: SceneEntry): Bounds {
  const node = document.nodes[entry.id]
  const scale = Math.max(Math.hypot(entry.matrix[0], entry.matrix[1]), Math.hypot(entry.matrix[2], entry.matrix[3]))
  const pad = Math.max(0, ...node.effects.filter(effect => effect.visible).map(effect =>
    effect.radius * 3 + Math.abs(effect.x || 0) + Math.abs(effect.y || 0) + Math.abs(effect.spread || 0)),
  ...node.strokes.filter(stroke => stroke.visible).map(stroke => stroke.width * 4)) * scale
  return { x: entry.bounds.x - pad, y: entry.bounds.y - pad,
    width: entry.bounds.width + pad * 2, height: entry.bounds.height + pad * 2 }
}

/** Collect each page root's existing scene envelope in one traversal rather
 * than filtering the whole scene once per root. Do not cache across documents
 * or pages: edits, derived group bounds and visibility are already reflected
 * in the supplied scene. Empty/hidden roots retain the original zero bounds.
 * A scene entry can belong to both an explicit root and an ancestor root;
 * retain that behavior without adding the same entry twice to one union. */
export function interactionRootBounds(document: DesignDocument, pageId: string, entries: readonly SceneEntry[]): Map<string, Bounds> {
  const groups = new Map((document.pages.find(page => page.id === pageId)?.children || [])
    .map(id => [id, [] as Bounds[]]))
  for (const entry of entries) {
    const direct = groups.get(entry.id), ancestor = groups.get(entry.ancestors[0])
    if (!direct && !ancestor) continue
    const bounds = paddedBounds(document, entry)
    direct?.push(bounds)
    if (ancestor && ancestor !== direct) ancestor.push(bounds)
  }
  return new Map([...groups].map(([id, bounds]) => [id, unionBounds(bounds)]))
}

export type InteractionDependencyScope = {
  rootBounds: Map<string, Bounds>
  parentLinear: Map<string, number[]>
  parentMatrices?: Map<string, Matrix>
  localizedBounds: Set<string>
  /** Simple leaves need no large speculative travel reserve. Semantic bounds
   * and capture-expansion checks are still identical to other localized edits. */
  shortTravelBounds: Set<string>
  fixedBounds: Set<string>
  dependencyPadding: number
  /** The branch follows every backdrop reader in its painter scopes. */
  finalForeground: boolean
}

/** An ordinary foreground branch cannot feed any earlier backdrop.
 * Check every sibling scope up to the page, not just a flattened DFS index:
 * an ancestor's later sibling can read the complete earlier branch.
 * This proves only dependency locality; the authored bounds below retain
 * exactly the same geometry assumptions as the existing no-backdrop path. */
function finalForegroundBranch(document: DesignDocument, pageId: string,
  entries: readonly SceneEntry[], entry: SceneEntry | undefined): boolean {
  const page = document.pages.find(page => page.id === pageId)
  if (!page || !entry?.ancestors.length || document.animations?.length ||
      Object.values(document.nodes).some(node => node.connector || node.textPath)) return false
  const derived = (node: DesignNode) => !!node.repeat || !!node.booleanOperation ||
    !!node.instance || !!node.instanceOrigin || !!node.component || !!node.componentSet || !!node.componentKey ||
    Object.keys(node.bindings || {}).length > 0 || Object.keys(node.variableModes || {}).length > 0 ||
    Object.keys(node.styleRefs || {}).length > 0 || !!node.layout && node.layout.mode !== 'none'
  const hugs = (node: DesignNode) => node.sizing?.width === 'hug' || node.sizing?.height === 'hug'
  // A single self-filter on the selected root changes only that source's
  // footprint. Keep nested filters and spatially varying/radial kernels on
  // the full dependency path: paddedBounds is not a sum of ancestor halos.
  const localRootEffects = (node: DesignNode) => {
    const effects = node.effects.filter(effect => effect.visible)
    return effects.length === 1 && effects.every(effect =>
      ['blur', 'gaussian-blur', 'shadow', 'inner-shadow', 'color-controls'].includes(effect.kind) &&
      !effect.gradientBlur && Number.isFinite(effect.radius) && effect.radius >= 0)
  }
  const ordinary = (node: DesignNode | undefined, selectedRoot = false): node is DesignNode => !!node &&
    node.blend === 'normal' && !node.mask &&
    (!node.effects.some(effect => effect.visible) || selectedRoot && localRootEffects(node)) && !derived(node) &&
    node.fills.every(paint => !paint.visible || paint.blend === 'normal') &&
    node.strokes.every(stroke => !stroke.visible || !stroke.paint.visible || stroke.paint.blend === 'normal')
  const independentLater = new Map<string,boolean>()
  const laterBranch = (id:string):boolean => {
    const known=independentLater.get(id);if(known!==undefined)return known
    const pending=[id],visited=new Set<string>()
    while(pending.length){
      const next=pending.pop()!,n=document.nodes[next]
      if(!n)return false
      if(!n.visible)continue
      const cached=independentLater.get(next);if(cached===false)return false;if(cached===true)continue
      if(visited.has(next))return false
      // Later isolated sources may blur their own pixels, but cannot read
      // this earlier branch. Boolean children are local to that later source.
      // Keep external/unknown dependencies and pass-through effects excluded.
      if(n.blend!=='normal'||n.mask||!effectsAreKnown(n.effects)||
          n.effects.some(e=>e.visible&&['background-blur','glass'].includes(e.kind))||
          !!n.repeat||!!n.instance||!!n.instanceOrigin||!!n.component||!!n.componentSet||!!n.componentKey||
          Object.keys(n.bindings||{}).length||Object.keys(n.variableModes||{}).length||Object.keys(n.styleRefs||{}).length||
          n.fills.some(p=>p.visible&&p.blend!=='normal')||
          n.strokes.some(s=>s.visible&&s.paint.visible&&s.paint.blend!=='normal')){
        independentLater.set(id,false);return false
      }
      visited.add(next);for(const child of n.children)pending.push(child)
    }
    for(const next of visited)independentLater.set(next,true)
    return true
  }
  const foregroundChild = (children: readonly string[], id: string) => {
    if (children.some(child => !document.nodes[child] || document.nodes[child].mask)) return false
    const at=children.indexOf(id)
    return at>=0&&children.slice(at+1).every(laterBranch)
  }
  for (const candidate of entries) {
    if (candidate.id !== entry.id && !candidate.ancestors.includes(entry.id)) continue
    const node = document.nodes[candidate.id]
    // Leaf text's own hug sizing stays within this same ordinary subtree.
    // Container sizing/layout could change authored descendant placement.
    if (!ordinary(node, candidate.id === entry.id) || node.kind !== 'text' && hugs(node)) return false
    if (candidate.id === entry.id && node.effects.some(effect => effect.visible)) {
      const [a,b,c,d] = candidate.matrix
      // Existing radius bounds use max column length. New admission therefore
      // excludes shear, whose spectral scale can exceed that quantity.
      if (![a,b,c,d].every(Number.isFinite) || a*c+b*d !== 0) return false
    }
  }
  let branch = entry.id
  for (const id of [...entry.ancestors].reverse()) {
    const parent = document.nodes[id]
    if (!ordinary(parent) || parent.opacity !== 1 || hugs(parent) || !foregroundChild(parent.children, branch)) return false
    branch = id
  }
  return foregroundChild(page.children, branch)
}

/** Conservative authored-scene capture estimates, NOT compiled reuse proofs.
 * Keep the established envelope arithmetic and localization rules in one place.
 * Kernel layout, effect support and exact output remain owned by the compiler. */
export function buildInteractionDependencyScope(document: DesignDocument, pageId: string,
  entries: readonly SceneEntry[], selection: readonly string[],
  { zoom, dpr, allowFixedBackdrop }: { zoom: number; dpr: number; allowFixedBackdrop: boolean }): InteractionDependencyScope {
  const scope: InteractionDependencyScope = { rootBounds: new Map(), parentLinear: new Map(), parentMatrices: new Map(),
    localizedBounds: new Set(), shortTravelBounds: new Set(), fixedBounds: new Set(), dependencyPadding: 0, finalForeground: false }
  // Bound propagation through all backdrop filters conservatively. This
  // is computed once per scene, not once per pointer sample.
  scope.dependencyPadding = pageBackdropPadding(document,entries)
  scope.rootBounds = interactionRootBounds(document, pageId, entries)
  // Small nested edits do not need a full-screen capture. Only localize
  // when no backdrop can propagate the changed pixels and every ancestor
  // is an ordinary effect-free, mask-free container; other selections
  // retain the conservative viewport dependency path.
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  scope.parentMatrices = new Map(selection.map(id =>
    [id, byId.get(byId.get(id)?.parent || '')?.matrix || [1, 0, 0, 1, 0, 0] as Matrix]))
  scope.parentLinear = new Map(selection.map(id =>
    [id, byId.get(byId.get(id)?.parent || '')?.matrix.slice(0, 4) || [1, 0, 0, 1]]))
  scope.localizedBounds = new Set()
  const knownEffects = entries.every(entry => effectsAreKnown(document.nodes[entry.id].effects))
  const noBackdrop = knownEffects && entries.every(entry => !document.nodes[entry.id].effects.some(e =>
    e.visible && ['background-blur', 'glass'].includes(e.kind)))
  const finalForeground = !noBackdrop && knownEffects && selection.length === 1 &&
    finalForegroundBranch(document, pageId, entries, byId.get(selection[0]))
  scope.finalForeground = finalForeground
  // Earlier filters have already sampled their backdrop before this branch.
  // Their read support cannot propagate a change in the final foreground.
  if (finalForeground) scope.dependencyPadding = 0
  if (noBackdrop || finalForeground) for (const id of selection) {
    const entry = byId.get(id), selected = document.nodes[id]
    if (!entry || !entry.ancestors.length || selected.mask || entry.ancestors.some(id => {
      const n = document.nodes[id]
      return n.mask || n.effects.some(e => e.visible) || n.children.some(id => document.nodes[id]?.mask)
    })) continue
    const affected = entries.filter(e => e.id === id || e.ancestors.includes(id))
      .map(entry => paddedBounds(document, entry))
    let bounds = unionBounds(affected)
    if (finalForeground && selected.effects.some(effect => effect.visible)) {
      // The selected root's filter also expands descendant stroke support.
      // Unioning individual padded nodes alone cannot account for that sum.
      const scale = Math.max(Math.hypot(entry.matrix[0], entry.matrix[1]), Math.hypot(entry.matrix[2], entry.matrix[3]))
      const pad = Math.max(0, ...selected.effects.filter(effect => effect.visible).map(effect =>
        effect.radius * 3 + Math.abs(effect.x || 0) + Math.abs(effect.y || 0) + Math.abs(effect.spread || 0))) * scale
      bounds = { x: bounds.x-pad, y: bounds.y-pad, width: bounds.width+2*pad, height: bounds.height+2*pad }
    }
    scope.rootBounds.set(id, bounds)
    scope.localizedBounds.add(id)
    if (!selected.children.length && ['text', 'rectangle', 'ellipse'].includes(selected.kind) &&
        !selected.repeat && !selected.textPath && !selected.network && !selected.vectorGeometry &&
        !selected.effects.some(effect => effect.visible) && !selected.strokes.some(stroke => stroke.visible) &&
        selected.fills.every(paint => !paint.visible || paint.kind === 'solid')) scope.shortTravelBounds.add(id)
  }
  // A nested edit cannot escape a fixed, clipped page root. Capture
  // that complete dependency scope even when it has background blur;
  // a large Retina viewport must not force a small board to half density.
  // Optical reads and ancestor layout remain on the conservative path.
  scope.fixedBounds = new Set()
  const finiteBackdrop = !allowsReducedSampling(zoom) || !entries.some(entry => document.nodes[entry.id].effects.some(e => e.visible && e.kind === 'glass'))
  if (knownEffects && !noBackdrop && finiteBackdrop && allowFixedBackdrop) for (const id of selection) {
    if (scope.localizedBounds.has(id)) continue
    const entry=byId.get(id), rootId=entry?.ancestors[0], root=rootId&&document.nodes[rootId], rootEntry=rootId&&byId.get(rootId)
    if(!entry||!root||!rootEntry||root.kind!=='frame'||!root.clip||root.mask||
      root.effects.some(e=>e.visible&&e.kind!=='background-blur'&&e.kind!=='glass')||entry.ancestors.some(id=>{
        const n=document.nodes[id]
        return n.layout&&n.layout.mode!=='none'||n.sizing?.width==='hug'||n.sizing?.height==='hug'||
          !!n.instance||!!n.instanceOrigin||!!n.component||!!n.componentSet||!!n.componentKey||
          Object.keys(n.bindings||{}).length>0||Object.keys(n.variableModes||{}).length>0
      }))continue
    const b=rootEntry.bounds,edge=2/Math.max(1e-6,zoom*dpr)
    scope.rootBounds.set(id,{x:b.x-edge,y:b.y-edge,width:b.width+edge*2,height:b.height+edge*2})
    scope.localizedBounds.add(id);scope.fixedBounds.add(id)
  }
  return scope
}
