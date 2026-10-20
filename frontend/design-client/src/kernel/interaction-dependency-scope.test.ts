import { expect, test } from 'vitest'
import { blank, node, effect, paint, stroke, type DesignDocument } from '../model'
import { scene, unionBounds } from '../geometry'
import { buildInteractionDependencyScope, interactionRootBounds, type InteractionDependencyScope } from './interaction-scene-bounds'
import { pageBackdropPadding, planInteractionLayers } from './interaction-layers'
import { allowsReducedSampling } from './render-quality'
import { VectorEngine } from '../generated/design-kernel/design_kernel'

// Frozen inline localization logic from the tested pre-refactor renderer.
function reference(document: DesignDocument, selection: string[], zoom: number, dpr: number, allowFixedBackdrop: boolean) {
  const pageId = document.pages[0].id, entries = scene(document, pageId)
  const scope: InteractionDependencyScope = { rootBounds: new Map(), parentLinear: new Map(), localizedBounds: new Set(), fixedBounds: new Set(), dependencyPadding: 0 }
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
  const noBackdrop = entries.every(entry => !document.nodes[entry.id].effects.some(e =>
    e.visible && ['background-blur', 'glass'].includes(e.kind)))
  if (noBackdrop) for (const id of selection) {
    const entry = byId.get(id), selected = document.nodes[id]
    if (!entry || !entry.ancestors.length || selected.mask || entry.ancestors.some(id => {
      const n = document.nodes[id]
      return n.mask || n.effects.some(e => e.visible) || n.children.some(id => document.nodes[id]?.mask)
    })) continue
    const affected = entries.filter(e => e.id === id || e.ancestors.includes(id)).map(e => {
      const n = document.nodes[e.id], scale = Math.max(Math.hypot(e.matrix[0], e.matrix[1]), Math.hypot(e.matrix[2], e.matrix[3]))
      const pad = Math.max(0, ...n.effects.filter(e => e.visible).map(e => e.radius * 3 + Math.abs(e.x || 0) + Math.abs(e.y || 0) + Math.abs(e.spread || 0)),
        ...n.strokes.filter(s => s.visible).map(s => s.width * 4)) * scale
      return { x: e.bounds.x - pad, y: e.bounds.y - pad, width: e.bounds.width + 2 * pad, height: e.bounds.height + 2 * pad }
    })
    scope.rootBounds.set(id, unionBounds(affected))
    scope.localizedBounds.add(id)
  }
  // A nested edit cannot escape a fixed, clipped page root. Capture
  // that complete dependency scope even when it has background blur;
  // a large Retina viewport must not force a small board to half density.
  // Optical reads and ancestor layout remain on the conservative path.
  scope.fixedBounds = new Set()
  const finiteBackdrop = !allowsReducedSampling(zoom) || !entries.some(entry => document.nodes[entry.id].effects.some(e => e.visible && e.kind === 'glass'))
  if (!noBackdrop && finiteBackdrop && allowFixedBackdrop) for (const id of selection) {
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
function fixture() {
  const document = blank(), root = node('frame', 4, 5, 80, 70), group = node('group', 3, 4, 50, 50), leaf = node('rectangle', 8, 9, 20, 25)
  root.clip = true; root.children = [group.id]; group.children = [leaf.id]
  root.blend = group.blend = 'normal'; leaf.fills = [paint('#a13c28')]; leaf.strokes = [stroke('#124e89', 1.25)]
  for (const n of [root, group, leaf]) document.nodes[n.id] = n
  document.pages[0].children = [root.id]
  return { document, root, group, leaf }
}
test('centralized authored capture estimates are exactly equivalent across dependency gates', () => {
  for (const kind of ['none', 'blur', 'shadow', 'background-blur', 'glass', 'mask', 'layout', 'binding'] as const)
    for (const zoom of [.2, 1]) for (const allowFixedBackdrop of [false, true]) {
      const { document, root, group, leaf } = fixture()
      if (kind === 'mask') leaf.mask = true
      else if (kind === 'layout') group.layout = { mode: 'horizontal' } as typeof group.layout
      else if (kind === 'binding') group.bindings = { opacity: 'v' } as typeof group.bindings
      else if (kind !== 'none') (kind === 'background-blur' || kind === 'glass' ? root : leaf).effects = [{ ...effect(kind), radius: 2.5 }]
      const options = { zoom, dpr: 2, allowFixedBackdrop }
      const actual = buildInteractionDependencyScope(document, document.pages[0].id, scene(document, document.pages[0].id), [leaf.id], options)
      expect(actual).toEqual(reference(document, [leaf.id], zoom, 2, allowFixedBackdrop))
    }
})
test('unknown visible effects cannot localize captures or flatten authored layers', () => {
  const { document, leaf, root } = fixture()
  leaf.effects = [{ ...effect('blur'), kind: 'future-effect' as never }]
  const scope = buildInteractionDependencyScope(document, document.pages[0].id, scene(document, document.pages[0].id), [leaf.id], { zoom: 1, dpr: 1, allowFixedBackdrop: true })
  expect(scope.localizedBounds.size).toBe(0); expect(scope.fixedBounds.size).toBe(0)
  expect(planInteractionLayers(document, document.pages[0].id, [root.id])).toBeNull()
})
test('localized capture options and real CPU-WASM bytes remain identical', () => {
  const { document, leaf } = fixture(); leaf.effects = [{ ...effect('shadow'), radius: 2, x: -2, y: 3 }]
  const pageId = document.pages[0].id, selected = [leaf.id]
  const old = reference(document, selected, 1, 1, true)
  const next = buildInteractionDependencyScope(document, pageId, scene(document, pageId), selected, { zoom: 1, dpr: 1, allowFixedBackdrop: true })
  const options = (scope: InteractionDependencyScope) => {
    const b = scope.rootBounds.get(leaf.id)!, x = Math.floor(b.x), y = Math.floor(b.y)
    return JSON.stringify({ pageId, width: Math.ceil(b.x + b.width) - x, height: Math.ceil(b.y + b.height) - y,
      view: { x: -x, y: -y, zoom: 1 }, transparent: true, grid: false, rasterProfile: 'analytic' })
  }
  expect(options(next)).toBe(options(old))
  const kernel = new VectorEngine()
  try {
    kernel.load_document(JSON.stringify(document))
    const a = kernel.render_rgba(options(old)), b = kernel.render_rgba(options(next))
    expect(b).toEqual(a); expect(a.some((value, i) => i % 4 === 3 && value > 0)).toBe(true)
  } finally { kernel.free() }
})
