import React from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { Layers } from './Layers'
import { allParents, worldMatrix } from './geometry'
import { blank, node } from './model'
import { alignmentAvailability } from './alignment-availability'
import { canvasMenuItems, lockedSelectionIds } from './canvas-menu-model'
import { canvasLayerFeedback } from './canvas-layer-feedback'
import { layerDropPlan } from './layer-drop'
import { propertyUnits } from './property-units'

const scans = vi.hoisted(() => ({ count: 0 }))
vi.mock('./kernel/translation-preview', async importOriginal => {
  const actual = await importOriginal<typeof import('./kernel/translation-preview')>()
  return { ...actual, PoseTopology: class extends actual.PoseTopology {
    constructor(document: ConstructorParameters<typeof actual.PoseTopology>[0]) {
      super(document)
      scans.count++
    }
  } }
})
vi.mock('./geometry', async importOriginal => {
  const actual = await importOriginal<typeof import('./geometry')>()
  return { ...actual, allParents: (...args: Parameters<typeof actual.allParents>) => {
    scans.count++
    return actual.allParents(...args)
  } }
})
const editors: Editor[] = []
afterEach(() => { editors.splice(0).forEach(editor => editor.dispose()); vi.unstubAllGlobals() })

function fixture() {
  const doc = blank(), a = node('frame', 10, 20, 200, 200), b = node('frame', 300, 40, 200, 200),
    child = node('rectangle', 15, 25, 30, 40)
  a.children = [child.id]
  doc.nodes = { [a.id]: a, [b.id]: b, [child.id]: child }
  doc.pages[0].children = [a.id, b.id]
  const editor = new Editor(doc); editors.push(editor); editor.select([child.id])
  return { editor, a, b, child }
}

test('toolbar, menus, layer feedback and drop queries share one published topology scan', () => {
  const { editor, a, b, child } = fixture(), original = editor.state.doc
  scans.count = 0
  for (let repeat = 0; repeat < 20; repeat++) {
    expect(alignmentAvailability(editor).align).toBe(true)
    expect(lockedSelectionIds(editor)).toEqual([])
    expect(canvasMenuItems(editor).find(item => item.command === 'delete')?.disabled).toBe(false)
    expect(canvasLayerFeedback(original, editor.state.page, editor.state.selection, editor.parentMap()).ids).toEqual([child.id])
    expect(layerDropPlan(original, editor.state.page, [child.id], b.id, 'inside', editor.parentMap())).toEqual({ parent: b.id })
    expect(propertyUnits(original, child.id, editor.parentMap()).style).toBe(1)
    expect(editor.parentMap().get(child.id)).toBe(a.id)
    editor.set({ view: { x: repeat, y: repeat, zoom: 1 } })
  }
  expect(scans.count).toBe(1)
  expect(editor.state.doc).toBe(original)
  expect(editor.canUndo).toBe(false)
})

test('reparent, undo and redo use the correct topology while an older published snapshot stays readable', () => {
  const { editor, a, b, child } = fixture(), original = editor.state.doc, originalMap = editor.parentMap()
  const before = worldMatrix(original, child.id, originalMap)
  editor.reparent(child.id, b.id)
  expect(editor.parentMap().get(child.id)).toBe(b.id)
  worldMatrix(editor.state.doc, child.id, editor.parentMap()).forEach((value, index) => expect(value).toBeCloseTo(before[index], 10))
  expect(editor.parentMap(original).get(child.id)).toBe(a.id)
  expect(editor.parentMap(original)).toBe(originalMap)
  editor.undo(); expect(editor.parentMap().get(child.id)).toBe(a.id)
  editor.redo(); expect(editor.parentMap().get(child.id)).toBe(b.id)
})

test('a published root reused with new nodes, pages or a new editor version cannot retain stale parents', () => {
  const { editor, a, b, child } = fixture()
  const published = structuredClone(editor.state.doc)
  editor.set({ doc: published })
  const first = editor.parentMap()
  published.nodes = { ...published.nodes,
    [a.id]: { ...published.nodes[a.id], children: [] },
    [b.id]: { ...published.nodes[b.id], children: [child.id] } }
  expect(editor.parentMap().get(child.id)).toBe(b.id)
  expect(editor.parentMap()).not.toBe(first)
  const second = editor.parentMap()
  published.pages = [{ ...published.pages[0], id: 'replacement-page' }]
  expect(editor.parentMap().get(a.id)).toBe('replacement-page')
  expect(editor.parentMap()).not.toBe(second)
  // Explicit publication of a new version must invalidate even if a host
  // retained the root, node map, pages and child-array object identities.
  published.nodes[b.id].children.splice(0, 1)
  published.nodes[a.id].children.push(child.id)
  editor.set({ version: editor.state.version + 1 })
  expect(editor.parentMap().get(child.id)).toBe(a.id)
})

test('allParents remains fresh for multiple mutations of the same unpublished draft', () => {
  const { editor, a, b, child } = fixture(), draft = structuredClone(editor.state.doc)
  const first = allParents(draft)
  draft.nodes[a.id].children.splice(0, 1); draft.nodes[b.id].children.push(child.id)
  expect(allParents(draft).get(child.id)).toBe(b.id)
  expect(first.get(child.id)).toBe(a.id)
  draft.nodes[b.id].children.splice(0, 1); draft.pages[0].children.push(child.id)
  expect(allParents(draft).get(child.id)).toBe(draft.pages[0].id)
})

// Exercise the production Layers key handler. React hooks/host are controlled;
// this is a topology-work regression, not DOM layout or input-to-photon timing.
function renderLayers(editor: Editor) {
  const hooks = {
    useState: (initial: any) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useRef: (current: any) => ({ current }),
    useId: () => 'parent-map-layer-test',
    useEffect() {},
    useMemo: (fn: () => unknown) => fn(),
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  }
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
  const previous = internals.H
  internals.H = hooks
  try { return Layers({ editor }) } finally { internals.H = previous }
}
function findRow(tree: any): any {
  if (!tree || typeof tree !== 'object') return
  if (tree.props?.role === 'treeitem') return tree
  for (const child of [tree.props?.children].flat(Infinity)) {
    const row = findRow(child)
    if (row) return row
  }
}
test('ArrowLeft at a root scans topology once even when no parent row exists among 2000 rows', () => {
  const doc = blank()
  for (let index = 0; index < 2000; index++) {
    const item = node('rectangle', index * 20, 0, 10, 10)
    doc.nodes[item.id] = item; doc.pages[0].children.push(item.id)
  }
  const editor = new Editor(doc); editors.push(editor)
  const row = findRow(renderLayers(editor)), target = {}
  scans.count = 0
  row.props.onKeyDown({ key: 'ArrowLeft', target, currentTarget: target, preventDefault() {}, stopPropagation() {} })
  expect(scans.count).toBe(1)
  expect(editor.state.selection).toEqual([])
  expect(editor.canUndo).toBe(false)
})

test('layout-order probing shares the immutable gesture baseline and refreshes after reparent/undo', () => {
  const { editor, a, b, child } = fixture()
  editor.begin('Move')
  const before = editor.state.doc
  scans.count = 0
  for (let i = 0; i < 32; i++) expect(editor.previewLayoutOrder(child.id, { x: 25+i, y: 45 })).toBe(false)
  expect(scans.count).toBeLessThanOrEqual(1)
  expect(editor.state.doc).toBe(before)
  editor.cancel();editor.reparent(child.id,b.id)
  expect(editor.parentMap().get(child.id)).toBe(b.id)
  editor.begin('Move again');scans.count=0
  for(let i=0;i<16;i++)expect(editor.previewLayoutOrder(child.id,{x:350+i,y:65})).toBe(false)
  expect(scans.count).toBeLessThanOrEqual(1)
  editor.cancel();editor.undo();expect(editor.parentMap().get(child.id)).toBe(a.id)
})
