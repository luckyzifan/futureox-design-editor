import { effectsAreKnown } from './render-dependency'
import { allowsReducedSampling } from './render-quality'
import { pageBackdropPadding } from './interaction-layers'
import type { Bounds, DesignDocument } from '../model'
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
  localizedBounds: Set<string>
  fixedBounds: Set<string>
  dependencyPadding: number
}

/** Conservative authored-scene capture estimates, NOT compiled reuse proofs.
 * Keep the established envelope arithmetic and localization rules in one place.
 * Kernel layout, effect support and exact output remain owned by the compiler. */
export function buildInteractionDependencyScope(document: DesignDocument, pageId: string,
  entries: readonly SceneEntry[], selection: readonly string[],
  { zoom, dpr, allowFixedBackdrop }: { zoom: number; dpr: number; allowFixedBackdrop: boolean }): InteractionDependencyScope {
  const scope: InteractionDependencyScope = { rootBounds: new Map(), parentLinear: new Map(),
    localizedBounds: new Set(), fixedBounds: new Set(), dependencyPadding: 0 }
  // Bound propagation through all backdrop filters conservatively. This
  // is computed once per scene, not once per pointer sample.
  scope.dependencyPadding = pageBackdropPadding(document,entries)
  scope.rootBounds = interactionRootBounds(document, pageId, entries)
  // Small nested edits do not need a full-screen capture. Only localize
  // when no backdrop can propagate the changed pixels and every ancestor
  // is an ordinary effect-free, mask-free container; other selections
  // retain the conservative viewport dependency path.
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  scope.parentLinear = new Map(selection.map(id =>
    [id, byId.get(byId.get(id)?.parent || '')?.matrix.slice(0, 4) || [1, 0, 0, 1]]))
  scope.localizedBounds = new Set()
  const knownEffects = entries.every(entry => effectsAreKnown(document.nodes[entry.id].effects))
  const noBackdrop = knownEffects && entries.every(entry => !document.nodes[entry.id].effects.some(e =>
    e.visible && ['background-blur', 'glass'].includes(e.kind)))
  if (noBackdrop) for (const id of selection) {
    const entry = byId.get(id), selected = document.nodes[id]
    if (!entry || !entry.ancestors.length || selected.mask || entry.ancestors.some(id => {
      const n = document.nodes[id]
      return n.mask || n.effects.some(e => e.visible) || n.children.some(id => document.nodes[id]?.mask)
    })) continue
    const affected = entries.filter(e => e.id === id || e.ancestors.includes(id))
      .map(entry => paddedBounds(document, entry))
    scope.rootBounds.set(id, unionBounds(affected))
    scope.localizedBounds.add(id)
  }
  // A nested edit cannot escape a fixed, clipped page root. Capture
  // that complete dependency scope even when it has background blur;
  // a large Retina viewport must not force a small board to half density.
  // Optical reads and ancestor layout remain on the conservative path.
  scope.fixedBounds = new Set()
  const finiteBackdrop = !allowsReducedSampling(zoom) || !entries.some(entry => document.nodes[entry.id].effects.some(e => e.visible && e.kind === 'glass'))
  if (knownEffects && !noBackdrop && finiteBackdrop && allowFixedBackdrop) for (const id of selection) {
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
