import { expect, test } from 'vitest'
import { Editor } from './engine'
import { copiedScene, deepScene, largeScene } from './stress-fixtures'
import { validateDocument } from './model'
import { scene, apply } from './geometry'
import { zoomAt } from './canvas-view'

test('copy preserves every node of a 40-level hierarchy and isolates subsequent edits', () => {
  const doc = deepScene(), copied = copiedScene(doc)
  expect(validateDocument(copied)).toBeTruthy()
  expect(Object.keys(copied.nodes)).toHaveLength(Object.keys(doc.nodes).length)
  expect(Object.keys(copied.nodes).some(id => id in doc.nodes)).toBe(false)
  const original = scene(doc, doc.pages[0].id), clone = scene(copied, copied.pages[0].id)
  for (let i=0; i<original.length; i++) {
    const a = original[i].matrix, b = clone[i].matrix
    expect(b.slice(0,4)).toEqual(a.slice(0,4))
    expect(b[4]-a[4]).toBeCloseTo(24,9)
    expect(b[5]-a[5]).toBeCloseTo(24,9)
  }
  const child = Object.values(copied.nodes).find(n=>n.fills.length)!
  child.fills[0].color = '#000000'
  expect(Object.values(doc.nodes).some(n=>n.fills.some(p=>p.color==='#000000'))).toBe(false)
})
test('large copy crosses the former 20000-node ceiling and preserves undo/redo', () => {
  const editor = new Editor(largeScene(5000))
  editor.select(editor.state.doc.pages[0].children)
  editor.duplicate()
  expect(Object.keys(editor.state.doc.nodes)).toHaveLength(10002)
  expect(validateDocument(editor.state.doc)).toBeTruthy()
  const duplicated = editor.state.doc
  editor.undo()
  expect(Object.keys(editor.state.doc.nodes)).toHaveLength(5001)
  editor.redo()
  expect(editor.state.doc).toEqual(duplicated)
  editor.duplicate()
  expect(Object.keys(editor.state.doc.nodes)).toHaveLength(15003)
  const before = editor.state.doc
  editor.duplicate()
  expect(Object.keys(editor.state.doc.nodes)).toHaveLength(20004)
  const beyondLegacyLimit = editor.state.doc
  editor.undo(); expect(editor.state.doc).toBe(before)
  editor.redo(); expect(editor.state.doc).toBe(beyondLegacyLimit)
  editor.dispose()
}, 60000)
test('grouping beyond the renderer depth budget leaves the previous scene intact', () => {
  const editor = new Editor(deepScene(64))
  editor.select(editor.state.doc.pages[0].children)
  const before = editor.state.doc
  editor.group()
  expect(editor.state.doc).toBe(before)
  expect(editor.state.message).toContain('64')
})
test('zooming around an anchor preserves its world coordinate at large positions', () => {
  const p = {x:321.125,y:199.625}
  const original = { x:-1_000_000, y:2_000_000, zoom:1 }
  const world = {x:(p.x-original.x)/original.zoom,y:(p.y-original.y)/original.zoom}
  for (const zoom of [0.025,0.25,0.5,1,2,8,32]) {
    const view = zoomAt(original,zoom,p)
    const projected = apply([view.zoom,0,0,view.zoom,view.x,view.y],world)
    expect(projected.x).toBeCloseTo(p.x,6)
    expect(projected.y).toBeCloseTo(p.y,6)
  }
})
