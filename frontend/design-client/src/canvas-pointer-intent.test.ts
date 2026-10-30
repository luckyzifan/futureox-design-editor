import {selectedChildDragIntent} from './canvas-pointer-intent'
import { expect, test } from 'vitest'
import { dragThresholdPassed, selectedGroupDragIntent, selectionPointerDown, frameTitleHit } from './canvas-pointer-intent'
import { Editor } from './engine'
import { blank, node } from './model'
import { contains } from './geometry'

test('frame title picking keeps page, inherited lock and visibility boundaries',()=>{
  const doc=blank(),frame=node('frame'),section=node('section'),child=node('frame'),leaf=node('rectangle')
  section.children=[child.id];doc.nodes=Object.fromEntries([frame,section,child,leaf].map(n=>[n.id,n]));doc.pages[0].children=[frame.id,section.id,leaf.id]
  const page=doc.pages[0].id
  expect(frameTitleHit(doc,page,frame.id)).toBe(frame.id)
  expect(frameTitleHit(doc,page,section.id)).toBe(section.id)
  expect(frameTitleHit(doc,page,leaf.id)).toBeNull()
  expect(frameTitleHit(doc,page,null)).toBeNull()
  expect(frameTitleHit(doc,'other-page',frame.id)).toBeNull()
  section.locked=true;expect(frameTitleHit(doc,page,child.id)).toBeNull()
  section.locked=false;section.visible=false;expect(frameTitleHit(doc,page,child.id)).toBeNull()
  expect(selectionPointerDown([frame.id],section.id,true).selection).toEqual([frame.id,section.id])
})

test('a selected group retains transparent interior drag ownership but defers ordinary click-through', () => {
  const group = node('group', 100, 100, 100, 100)
  const options = { inside: true, deep: false, additive: false, readOnly: false }
  expect(selectedGroupDragIntent(group, 'background', options)).toEqual({ selection: [group.id], clickSelection: ['background'] })
  expect(selectedGroupDragIntent(group, null, options)).toEqual({ selection: [group.id], clickSelection: [] })
  expect(selectedGroupDragIntent(group, group.id, options)).toEqual({ selection: [group.id], clickSelection: null })
  for (const changed of [{ inside: false }, { deep: true }, { additive: true }, { readOnly: true }])
    expect(selectedGroupDragIntent(group, 'background', { ...options, ...changed })).toBeNull()
  expect(selectedGroupDragIntent({ ...group, locked: true }, 'background', options)).toBeNull()
  expect(selectedGroupDragIntent({ ...group, visible: false }, 'background', options)).toBeNull()
  expect(selectedGroupDragIntent({ ...group, kind: 'frame' }, 'background', options)).toBeNull()
})

test('real picking behind a selected hollow group cannot redirect its drag to the page-sized backing layer', () => {
  const document = blank(), background = node('rectangle', 0, 0, 1920, 1080)
  const group = node('group', 200, 200, 100, 100), left = node('rectangle', 0, 0, 20, 100), right = node('rectangle', 80, 0, 20, 100)
  group.children = [left.id, right.id]
  document.nodes = Object.fromEntries([background, group, left, right].map(value => [value.id, value]))
  document.pages[0].children = [background.id, group.id]
  const editor = new Editor(document)
  try {
    editor.select([group.id])
    const before = editor.state.doc, point = { x: 250, y: 250 }
    const rawHit = editor.hit(point)
    expect(rawHit).toBe(background.id) // Reproduces the actual 117 empty-chart hit.
    const intent = selectedGroupDragIntent(before.nodes[group.id], rawHit,
      { inside: contains(editor.selectionBounds(), point), deep: false, additive: false, readOnly: false })!
    editor.select(intent.selection)
    expect(dragThresholdPassed({ x: 0, y: 0 }, { x: 32, y: 24 }, false)).toBe(true)
    editor.transformSelection([1, 0, 0, 1, 32, 24], '拖动已选组合')
    expect(editor.state.doc.nodes[group.id].transform).toEqual([1, 0, 0, 1, 232, 224])
    expect(editor.state.doc.nodes[background.id]).toEqual(before.nodes[background.id])
    const after = editor.state.doc
    editor.undo(); expect(editor.state.doc.nodes).toEqual(before.nodes)
    editor.redo(); expect(editor.state.doc.nodes).toEqual(after.nodes)
    // A modifier/deep hit still selects the actual underlying target.
    expect(selectedGroupDragIntent(group, rawHit, { inside: true, deep: true, additive: false, readOnly: false })).toBeNull()
  } finally { editor.dispose() }
})

test('multiselection gaps retain the drag owner but a click still clears selection',()=>{
  expect(selectionPointerDown(['a','b'],null,false,true)).toEqual({selection:['a','b'],clickSelection:[]})
  expect(selectionPointerDown(['a','b'],null,true,true)).toEqual({selection:['a','b'],clickSelection:null})
  expect(selectionPointerDown(['a'],null,false,true)).toEqual({selection:[],clickSelection:null})
})

function gesture(current: readonly string[], hit: string | null, shift: boolean, points: { x: number; y: number }[]) {
  const intent = selectionPointerDown(current, hit, shift)
  const start = points[0]
  let moved = false
  for (const point of points.slice(1)) moved = dragThresholdPassed(start, point, moved)
  return { held: intent.selection, released: moved ? intent.selection : intent.clickSelection ?? intent.selection, moved }
}

test('Shift click defers removal until release, while Shift drag retains every selected layer', () => {
  expect(selectionPointerDown(['a', 'b'], 'a', true)).toEqual({ selection: ['a', 'b'], clickSelection: ['b'] })
  expect(gesture(['a', 'b'], 'a', true, [{ x: 10, y: 20 }, { x: 11, y: 20 }]))
    .toEqual({ held: ['a', 'b'], released: ['b'], moved: false })
  expect(gesture(['a', 'b'], 'a', true, [{ x: 10, y: 20 }, { x: 15, y: 20 }]))
    .toEqual({ held: ['a', 'b'], released: ['a', 'b'], moved: true })
})

test('clicking a member collapses a multiselection on release; dragging moves the whole selection', () => {
  expect(gesture(['a', 'b'], 'b', false, [{ x: 10, y: 20 }, { x: 10, y: 20 }]))
    .toEqual({ held: ['a', 'b'], released: ['b'], moved: false })
  expect(gesture(['a', 'b'], 'b', false, [{ x: 10, y: 20 }, { x: 10, y: 24 }]))
    .toEqual({ held: ['a', 'b'], released: ['a', 'b'], moved: true })
})

test('new hits select or extend immediately; blank clicks preserve only an additive selection', () => {
  expect(selectionPointerDown(['a'], 'b', true)).toEqual({ selection: ['a', 'b'], clickSelection: null })
  expect(selectionPointerDown(['a'], 'b', false)).toEqual({ selection: ['b'], clickSelection: null })
  expect(selectionPointerDown(['a'], null, true)).toEqual({ selection: ['a'], clickSelection: null })
  expect(selectionPointerDown(['a'], null, false)).toEqual({ selection: [], clickSelection: null })
  expect(selectionPointerDown(['a'], 'a', true)).toEqual({ selection: ['a'], clickSelection: [] })
  expect(selectionPointerDown(['a'], 'a', false)).toEqual({ selection: ['a'], clickSelection: null })
})

test('fractional CSS coordinates do not round tiny motion into a drag, and the threshold is radial', () => {
  const start = { x: 0.125, y: -20.375 }
  expect(dragThresholdPassed(start, { x: 3.124, y: start.y }, false)).toBe(false)
  expect(dragThresholdPassed(start, { x: 3.125, y: start.y }, false)).toBe(true)
  expect(dragThresholdPassed(start, { x: start.x + 2, y: start.y + 2 }, false)).toBe(false)
  expect(dragThresholdPassed(start, { x: start.x + 2.25, y: start.y + 2.25 }, false)).toBe(true)
  expect(dragThresholdPassed(start, start, false)).toBe(false)
})

test('an intentional drag returning to its origin never performs a deferred click toggle', () => {
  const points = [{ x: 5.125, y: 7.875 }, { x: 8.125, y: 7.875 }, { x: 5.125, y: 7.875 }]
  expect(gesture(['a', 'b'], 'a', true, points)).toEqual({ held: ['a', 'b'], released: ['a', 'b'], moved: true })
  expect(gesture(['a', 'b'], 'a', false, points)).toEqual({ held: ['a', 'b'], released: ['a', 'b'], moved: true })
})

test('custom thresholds and malformed events cannot turn a stationary click into a drag', () => {
  const start = { x: 0, y: 0 }
  expect(dragThresholdPassed(start, { x: 2, y: 0 }, false, 2)).toBe(true)
  expect(dragThresholdPassed(start, start, false, 0)).toBe(false)
  for (const threshold of [-1, NaN, Infinity]) expect(dragThresholdPassed(start, { x: 50, y: 0 }, false, threshold)).toBe(false)
  expect(dragThresholdPassed(start, { x: NaN, y: 0 }, false)).toBe(false)
  expect(dragThresholdPassed(start, { x: Infinity, y: 0 }, false)).toBe(false)
  expect(dragThresholdPassed(start, start, true)).toBe(true)
})

test('selection intent owns its arrays and cannot mutate editor selection by alias', () => {
  const current = Object.freeze(['a', 'b'])
  for (const hit of ['a', 'new', null]) for (const additive of [true, false]) {
    const result = selectionPointerDown(current, hit, additive)
    result.selection.push('local')
    result.clickSelection?.push('release')
    expect(current).toEqual(['a', 'b'])
    expect(result.selection).not.toContain('release')
  }
})


test('selected child drag only defers ancestor/empty hits within its own outline',()=>{
 const child={id:'child',visible:true,locked:false},options={inside:true,deep:false,additive:false,readOnly:false}
 expect(selectedChildDragIntent(child,'parent',['frame','parent'],options)).toEqual({selection:['child'],clickSelection:['parent']})
 expect(selectedChildDragIntent(child,null,['frame','parent'],options)).toEqual({selection:['child'],clickSelection:[]})
 expect(selectedChildDragIntent(child,'sibling',['frame','parent'],options)).toBeNull()
 for(const change of [{inside:false},{deep:true},{additive:true},{readOnly:true}])expect(selectedChildDragIntent(child,'parent',['parent'],{...options,...change})).toBeNull()
 expect(selectedChildDragIntent({...child,locked:true},'parent',['parent'],options)).toBeNull()
})
