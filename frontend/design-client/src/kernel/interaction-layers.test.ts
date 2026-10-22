import { expect, test } from 'vitest'
import { blank, node, effect } from '../model'
import { interactionOffsets, interactionPatchedDocument, interactionPatchedOffsets, planInteractionLayers, pageBackdropPadding } from './interaction-layers'
import {scene} from '../geometry'

test('overlapping, interleaved selected boards retain their paint order and internal backdrop/masks', () => {
  const doc = blank(), roots = Array.from({ length: 5 }, (_, i) => node('frame', i * 10, 0, 300, 300))
  roots.forEach(root => { root.blend = 'normal'; doc.nodes[root.id] = root })
  const glass = node('rectangle', 20, 20, 80, 80); glass.effects = [effect('background-blur')]
  roots[1].children = [glass.id]; doc.nodes[glass.id] = glass
  doc.pages[0].children = roots.map(n => n.id)
  const plan = planInteractionLayers(doc, doc.pages[0].id, [roots[1].id, roots[3].id])!
  expect(plan.layers.map(layer => layer.document.pages[0].children.filter(id => layer.document.nodes[id].visible))).toEqual(roots.map(root => [root.id]))
  for (const layer of plan.layers) expect(layer.document.pages[0].children).toEqual(doc.pages[0].children)
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
