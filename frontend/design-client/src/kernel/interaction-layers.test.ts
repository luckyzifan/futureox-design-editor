import { expect, test, vi } from 'vitest'
import { blank, node, effect } from '../model'
import { InteractionLayerPlanner, interactionOffsets, interactionTransformsOnly, interactionPatchedDocument, interactionPatchedOffsets, planInteractionLayers, pageBackdropPadding } from './interaction-layers'
import { CanvasSceneSnapshots } from '../canvas-scene-snapshots'
import { produceDocumentDraft } from '../document-patch'
import {scene} from '../geometry'

test('an opted-in sole empty normal group splits into ordered independent subtree pixels',()=>{
 const doc=blank(),group=node('group',100,80,400,300),a=node('rectangle',10,10,80,80),b=node('rectangle',40,30,80,80),c=node('rectangle',70,60,80,80)
 group.blend='normal';group.children=[a.id,b.id,c.id];group.fills=[];group.strokes=[];group.effects=[];group.clip=false
 doc.nodes=Object.fromEntries([group,a,b,c].map(n=>[n.id,n]));doc.pages[0].children=[group.id]
 expect(planInteractionLayers(doc,doc.pages[0].id,[b.id])).toBeNull()
 const plan=planInteractionLayers(doc,doc.pages[0].id,[b.id],undefined,{neutralPageGroup:true})!
 expect(plan.layers.map(l=>l.roots)).toEqual([[a.id],[b.id],[c.id]])
 expect(plan.layers.map(l=>l.moving)).toEqual([undefined,b.id,undefined])
 expect(plan.layers.every(l=>l.document===doc)).toBe(true)
 for(const mutate of [()=>{group.opacity=.5},()=>{group.clip=true},()=>{group.fills=a.fills},()=>{group.effects=[effect('blur')]},()=>{a.mask=true},()=>{a.effects=[effect('background-blur')]},()=>{doc.pages[0].children.push(c.id)}]){
  const before=structuredClone(doc);mutate()
  expect(planInteractionLayers(doc,doc.pages[0].id,[b.id],undefined,{neutralPageGroup:true})).toBeNull()
  Object.assign(group,before.nodes[group.id]);Object.assign(a,before.nodes[a.id]);doc.pages=before.pages
 }
})

test('producer-witnessed poses avoid re-enumerating the node table and still reject unrelated edits', () => {
  const doc = blank(), a = node('rectangle', 0, 0, 40, 40), b = node('rectangle', 80, 0, 40, 40)
  doc.nodes = { [a.id]: a, [b.id]: b }; doc.pages[0].children = [a.id, b.id]
  const plan = { document: doc, pageId: doc.pages[0].id, ids: [a.id], layers: [] }
  const moved = produceDocumentDraft(doc, d => { d.nodes[a.id].transform[4] = 12 })
  const entries = Object.entries, keys = Object.keys
  const e = vi.spyOn(Object, 'entries').mockImplementation(((value: object) => {
    if (value === moved.nodes || value === doc.nodes) throw Error('Unexpected whole-node enumeration')
    return entries(value)
  }) as typeof Object.entries)
  const k = vi.spyOn(Object, 'keys').mockImplementation(value => {
    if (value === moved.nodes || value === doc.nodes) throw Error('Unexpected whole-node enumeration')
    return keys(value)
  })
  try {
    expect(interactionOffsets(plan, moved)?.get(a.id)).toEqual({ x: 12, y: 0 })
    expect(interactionTransformsOnly(plan, moved)).toBe(true)
  } finally { e.mockRestore(); k.mockRestore() }
  for (const changed of [
    produceDocumentDraft(moved, d => { d.nodes[b.id].opacity = .5 }),
    produceDocumentDraft(moved, d => { delete d.nodes[b.id] }),
    produceDocumentDraft(moved, d => { d.nodes[a.id].fills = [...d.nodes[a.id].fills] }),
  ]) {
    expect(interactionOffsets(plan, changed)).toBeNull()
    expect(interactionTransformsOnly(plan, changed)).toBe(false)
  }
  // A clone has no private witness. Its unrelated mutation must be found by
  // the original full comparison rather than by selected-ID hints.
  const unknown = { ...moved, nodes: { ...moved.nodes, [b.id]: { ...moved.nodes[b.id], opacity: .4 } } }
  expect(interactionOffsets(plan, unknown)).toBeNull()
  expect(interactionTransformsOnly(plan, unknown)).toBe(false)
})

test('overlapping, interleaved selected boards retain their paint order and internal backdrop/masks', () => {
  const doc = blank(), roots = Array.from({ length: 5 }, (_, i) => node('frame', i * 10, 0, 300, 300))
  roots.forEach(root => { root.blend = 'normal'; doc.nodes[root.id] = root })
  const glass = node('rectangle', 20, 20, 80, 80); glass.effects = [effect('background-blur')]
  roots[1].children = [glass.id]; doc.nodes[glass.id] = glass
  doc.pages[0].children = roots.map(n => n.id)
  const plan = planInteractionLayers(doc, doc.pages[0].id, [roots[1].id, roots[3].id])!
  expect(plan.layers.map(layer => layer.roots)).toEqual(roots.map(root => [root.id]))
  for (const layer of plan.layers) expect(layer.document).toBe(doc)
  expect(plan.layers[1].document.nodes[glass.id]).toBe(glass)
  const moved = interactionPatchedDocument(doc, { [roots[1].id]: { transform: [1, 0, 0, 1, 40, 20] } })
  expect(interactionOffsets(plan, moved)?.get(roots[1].id)).toEqual({ x: 30, y: 20 })
  expect(interactionOffsets(plan, { ...moved, nodes: { ...moved.nodes, [glass.id]: { ...glass, opacity: .5 } } })).toBeNull()
})

test('external backdrop, page masks and derived placement changes never become independent bitmaps', () => {
  const doc = blank(), root = node('frame', 0, 0, 100, 100)
  root.blend = 'normal'; doc.nodes[root.id] = root; doc.pages[0].children = [root.id]
  const plan = planInteractionLayers(doc, doc.pages[0].id, [root.id])!
  expect(interactionOffsets(plan, interactionPatchedDocument(doc, { [root.id]: { transform: [2, 0, 0, 2, 0, 0] } }))).toBeNull()
  root.effects = [effect('glass')]
  expect(planInteractionLayers(doc, doc.pages[0].id, [root.id])).toBeNull()
  root.effects = []; root.mask = true
  expect(planInteractionLayers(doc, doc.pages[0].id, [root.id])).toBeNull()
})

test('internal blur does not inflate cross-board dependency damage',()=>{
  const doc=blank(),root=node('frame',0,0,1000,1000),child=node('rectangle',10,10,100,100)
  root.blend='normal';root.effects=[{...effect('background-blur'),radius:18}]
  child.effects=[{...effect('background-blur'),radius:500}]
  root.children=[child.id];doc.nodes[root.id]=root;doc.nodes[child.id]=child;doc.pages[0].children=[root.id]
  expect(pageBackdropPadding(doc,scene(doc,doc.pages[0].id))).toBe(54)
  root.blend='pass-through'
  expect(pageBackdropPadding(doc,scene(doc,doc.pages[0].id))).toBe(1554)
})

test('stationary captures exclude distant boards while the selected board stays complete', () => {
  const doc = blank(), roots = [node('frame', 0, 0, 200, 200), node('frame', 400, 0, 200, 200), node('frame', 15000, 0, 200, 200)]
  for (const root of roots) { root.blend = 'normal'; doc.nodes[root.id] = root }
  doc.pages[0].children = roots.map(root => root.id)
  const viewport = { x: -50, y: -50, width: 800, height: 400 }
  const plan = planInteractionLayers(doc, doc.pages[0].id, [roots[1].id], viewport)!
  expect(plan.layers).toHaveLength(2)
  expect(plan.layers.find(layer => layer.moving)?.bounds.width).toBeGreaterThan(200)
  expect(plan.layers.every(layer => layer.bounds.width <= 800)).toBe(true)
  expect(plan.viewport).toEqual(viewport)
})

test('pointer translations do not enumerate an unchanged document and reject non-translation edits', () => {
  const doc = blank(), root = node('frame', 10, 20, 100, 100)
  root.blend = 'normal'; doc.nodes[root.id] = root; doc.pages[0].children = [root.id]
  const plan = planInteractionLayers(doc, doc.pages[0].id, [root.id])!
  let scans = 0
  doc.nodes = new Proxy(doc.nodes, { ownKeys(target) { scans++; return Reflect.ownKeys(target) } })
  for (let x = 1; x <= 100; x++) expect(interactionPatchedOffsets(plan, doc, {
    [root.id]: { transform: [1, 0, 0, 1, 10 + x, 20] },
  })?.get(root.id)).toEqual({ x, y: 0 })
  expect(scans).toBe(0)
  expect(interactionPatchedOffsets(plan, doc, { [root.id]: { opacity: .5 } })).toBeNull()
  expect(interactionPatchedOffsets(plan, doc, { [root.id]: { transform: [2, 0, 0, 2, 10, 20] } })).toBeNull()
  const edited = { ...doc, nodes: { ...doc.nodes, [root.id]: { ...root, opacity: .5 } } }
  expect(interactionPatchedOffsets(plan, edited, { [root.id]: { transform: [1, 0, 0, 1, 20, 20] } })).toBeNull()
})

test('camera preparation reads only selected ids for its exact source snapshot, but validates every replacement snapshot', () => {
  const doc = blank(), selected = node('frame', 10, 20, 100, 100), child = node('rectangle', 5, 5, 10, 10)
  selected.blend = 'normal'; selected.children = [child.id]
  doc.nodes[selected.id] = selected; doc.nodes[child.id] = child
  doc.pages[0].children = [selected.id]
  const plan = planInteractionLayers(doc, doc.pages[0].id, [selected.id])!
  let scans = 0
  doc.nodes = new Proxy(doc.nodes, { ownKeys(target) { scans++; return Reflect.ownKeys(target) } })
  for (let camera = 0; camera < 100; camera++)
    expect(interactionOffsets(plan, doc)).toEqual(new Map([[selected.id, { x: 0, y: 0 }]]))
  expect(scans).toBe(0)

  const moved = interactionPatchedDocument(doc, { [selected.id]: { transform: [1, 0, 0, 1, 23, -9] } })
  expect(interactionOffsets(plan, moved)?.get(selected.id)).toEqual({ x: 13, y: -29 })
  expect(scans).toBeGreaterThan(0)
  expect(interactionOffsets(plan, { ...moved, nodes: { ...moved.nodes,
    [child.id]: { ...child, opacity: .75 } } })).toBeNull()
  expect(interactionOffsets(plan, { ...moved, pages: [...moved.pages] })).toBeNull()

  // The general validator reports only own, reachable node keys and de-duplicates
  // selections. The snapshot shortcut retains that behavior for invalid plans.
  expect(interactionOffsets({ ...plan, ids: [selected.id, selected.id, 'missing', 'toString'] }, doc))
    .toEqual(new Map([[selected.id, { x: 0, y: 0 }]]))
})

test('nested selections split only empty independent wrappers and keep interleaved order',()=>{
 const doc=blank(),group=node('group',20,30,100,100),a=node('rectangle',0,0,40,40),b=node('rectangle',10,10,40,40),c=node('rectangle',20,20,40,40)
 group.blend='pass-through';group.fills=[];group.strokes=[];group.children=[a.id,b.id,c.id];group.transform=[0,2,-2,0,20,30]
 for(const n of [group,a,b,c])doc.nodes[n.id]=n
 doc.pages[0].children=[group.id]
 const plan=planInteractionLayers(doc,doc.pages[0].id,[a.id,c.id])!
 expect(plan.layers.map(layer=>layer.roots)).toEqual([[a.id],[b.id],[c.id]])
 expect(plan.parentLinear?.get(a.id)).toEqual([0,2,-2,0])
 group.opacity=.5;expect(planInteractionLayers(doc,doc.pages[0].id,[a.id])).toBeNull()
 group.opacity=1;group.clip=true;expect(planInteractionLayers(doc,doc.pages[0].id,[a.id])).toBeNull()
 group.clip=false;group.blend='normal';expect(planInteractionLayers(doc,doc.pages[0].id,[a.id])).toBeNull()
 group.blend='pass-through';expect(planInteractionLayers(doc,doc.pages[0].id,[group.id,a.id])).toBeNull()
})

test('root plans avoid the document parent table and camera changes only clip a borrowed structure', () => {
  const doc = blank(), roots = Array.from({ length: 3000 }, (_, i) => node('rectangle', i * 40, 0, 20, 20))
  for (const root of roots) doc.nodes[root.id] = root
  doc.pages[0].children = roots.map(root => root.id)
  let enumerations = 0
  doc.nodes = new Proxy(doc.nodes, { ownKeys(target) { enumerations++; return Reflect.ownKeys(target) } })
  const pageId = doc.pages[0].id, ids = [roots[100].id, roots[200].id], store = new CanvasSceneSnapshots(), owner = {}
  store.begin(owner, 1, pageId, true)
  const snapshot = store.currentScene(doc, pageId), borrowed = store.borrowCurrentScene(doc, pageId, 1)!
  let boundsReads = 0
  for (const entry of snapshot.entries) {
    const bounds = entry.bounds
    Object.defineProperty(entry, 'bounds', { get() { boundsReads++; return bounds } })
  }
  enumerations = 0
  const planner = new InteractionLayerPlanner(), options = { scene: borrowed, epoch: 1 }
  const before = planner.plan(doc, pageId, ids, { x: 0, y: 0, width: 100, height: 100 }, options)!
  const reads = boundsReads
  expect(reads).toBeGreaterThan(0)
  for (let x = 0; x < 60; x++) {
    const plan = planner.plan(doc, pageId, ids, { x: x * 100, y: 0, width: 200, height: 100 }, options)!
    expect(plan.layers.filter(layer => layer.moving).map(layer => layer.bounds))
      .toEqual(before.layers.filter(layer => layer.moving).map(layer => layer.bounds))
    expect(plan.parentLinear).toEqual(new Map(ids.map(id => [id, [1, 0, 0, 1]])))
  }
  expect(enumerations).toBe(0)
  expect(boundsReads).toBe(reads)
  // Eviction/session revocation must invalidate even a same-object cached plan.
  store.begin(owner, 2, pageId, true)
  roots[100].effects = [effect('glass')]
  expect(planner.plan(doc, pageId, ids, undefined, options)).toBeNull()
})

test('structural cache separates selections, neutral policy, publications and mutable callers', () => {
  const doc = blank(), group = node('group', 0, 0, 200, 100), a = node('rectangle', 0, 0, 40, 40), b = node('rectangle', 80, 0, 40, 40)
  group.blend = 'normal'; group.children = [a.id, b.id]; group.fills = []; group.strokes = []
  doc.nodes = { [group.id]: group, [a.id]: a, [b.id]: b }; doc.pages[0].children = [group.id]
  const pageId = doc.pages[0].id, store = new CanvasSceneSnapshots(), owner = {}, planner = new InteractionLayerPlanner()
  store.begin(owner, 1, pageId, true); store.currentScene(doc, pageId)
  const options = { scene: store.borrowCurrentScene(doc, pageId, 1)!, epoch: 1 }
  expect(planner.plan(doc, pageId, [a.id], undefined, options)).toBeNull()
  expect(planner.plan(doc, pageId, [a.id], undefined, { ...options, neutralPageGroup: true })?.layers[0].moving).toBe(a.id)
  expect(planner.plan(doc, pageId, [b.id], undefined, { ...options, neutralPageGroup: true })?.layers[1].moving).toBe(b.id)
  expect(planner.plan(doc, pageId, [a.id], undefined, options)).toBeNull()
  expect(planner.plan(doc, pageId, [group.id], undefined, options)).not.toBeNull()
  const changed = { ...doc, nodes: { ...doc.nodes, [group.id]: { ...group, mask: true } } }
  expect(planner.plan(changed, pageId, [group.id], undefined, options)).toBeNull()
  // Without a publication capability, identical objects remain mutable drafts.
  expect(planner.plan(doc, pageId, [group.id])).not.toBeNull()
  group.mask = true
  expect(planner.plan(doc, pageId, [group.id])).toBeNull()
  planner.clear()
})
