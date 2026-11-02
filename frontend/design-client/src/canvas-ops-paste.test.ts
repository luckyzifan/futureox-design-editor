import { afterEach, expect, test } from 'vitest'
import { Editor } from './engine'
import { blank, node } from './model'
import { allParents, worldMatrix } from './geometry'

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach(editor => editor.dispose()))

test('multi-selection paste keeps each copy under its own parent and steps parent X/Y by 10', () => {
  const doc = blank('parents')
  const frameA = node('frame', 10, 20, 200, 200), frameB = node('frame', 400, 30, 220, 180)
  const a = node('rectangle', 12, 18, 40, 30), b = node('rectangle', 22, 28, 50, 20)
  const angle = Math.PI / 5
  b.transform = [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 22, 28]
  frameA.children = [a.id]
  frameB.children = [b.id]
  doc.nodes = Object.fromEntries([frameA, frameB, a, b].map(item => [item.id, item]))
  doc.pages[0].children = [frameA.id, frameB.id]
  const editor = new Editor(doc)
  editors.push(editor)
  editor.select([a.id, b.id])
  editor.copy()
  const before = editor.state.doc
  editor.pasteToSelection()
  const copies = editor.state.selection
  expect(copies).toHaveLength(2)
  const copyA = copies.map(id => editor.state.doc.nodes[id]).find(item => Math.abs(item.width - a.width) < 1e-6)!
  const copyB = copies.map(id => editor.state.doc.nodes[id]).find(item => Math.abs(item.width - b.width) < 1e-6)!
  expect(allParents(editor.state.doc).get(copyA.id)).toBe(frameA.id)
  expect(allParents(editor.state.doc).get(copyB.id)).toBe(frameB.id)
  expect(editor.state.doc.pages[0].children).toEqual([frameA.id, frameB.id])
  expect(copyA.transform[4]).toBeCloseTo(22, 6)
  expect(copyA.transform[5]).toBeCloseTo(28, 6)
  expect(copyB.transform[0]).toBeCloseTo(b.transform[0], 6)
  expect(copyB.transform[1]).toBeCloseTo(b.transform[1], 6)
  expect(copyB.transform[4]).toBeCloseTo(32, 6)
  expect(copyB.transform[5]).toBeCloseTo(38, 6)
  expect(editor.state.doc.nodes[a.id]).toEqual(before.nodes[a.id])
  expect(editor.state.doc.nodes[b.id]).toEqual(before.nodes[b.id])
  expect(editor.state.doc.nodes[frameA.id].children[0]).toBe(a.id)
  expect(editor.state.doc.nodes[frameA.id].children[1]).toBe(copyA.id)
  editor.pasteToSelection()
  const again = editor.state.selection.map(id => editor.state.doc.nodes[id])
  const againA = again.find(item => Math.abs(item.width - a.width) < 1e-6)!
  expect(allParents(editor.state.doc).get(againA.id)).toBe(frameA.id)
  expect(againA.transform[4]).toBeCloseTo(32, 6)
  expect(againA.transform[5]).toBeCloseTo(38, 6)
  editor.undo()
  editor.undo()
  expect(editor.state.doc).toEqual(before)
  expect(editor.canUndo).toBe(false)
})

test('paste in place keeps a multi-parent copy in each source frame without stepping', () => {
  const doc = blank('paste in place parents')
  const frameA = node('frame', 10, 20, 200, 200), frameB = node('frame', 400, 30, 220, 180)
  const a = node('rectangle', 12, 18, 40, 30), b = node('rectangle', 22, 28, 50, 20)
  const angle = Math.PI / 6
  b.transform = [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 22, 28]
  frameA.children = [a.id]
  frameB.children = [b.id]
  doc.nodes = Object.fromEntries([frameA, frameB, a, b].map(item => [item.id, item]))
  doc.pages[0].children = [frameA.id, frameB.id]
  const editor = new Editor(doc)
  editors.push(editor)
  editor.select([a.id, b.id])
  editor.copy()
  editor.paste(true)
  const copies = editor.state.selection.map(id => editor.state.doc.nodes[id])
  const copyA = copies.find(item => Math.abs(item.width - a.width) < 1e-6)!
  const copyB = copies.find(item => Math.abs(item.width - b.width) < 1e-6)!
  expect(allParents(editor.state.doc).get(copyA.id)).toBe(frameA.id)
  expect(allParents(editor.state.doc).get(copyB.id)).toBe(frameB.id)
  expect(editor.state.doc.pages[0].children).toEqual([frameA.id, frameB.id])
  expect(copyA.transform[4]).toBeCloseTo(a.transform[4], 6)
  expect(copyA.transform[5]).toBeCloseTo(a.transform[5], 6)
  expect(copyB.transform[0]).toBeCloseTo(Math.cos(angle), 6)
  expect(copyB.transform[1]).toBeCloseTo(Math.sin(angle), 6)
  expect(copyB.transform[4]).toBeCloseTo(22, 6)
  expect(copyB.transform[5]).toBeCloseTo(28, 6)
})

test('a chosen frame still receives a multi-parent paste, and a locked parent refuses', () => {
  const doc = blank('destination')
  const frameA = node('frame', 0, 0, 180, 180), frameB = node('frame', 300, 0, 180, 180), target = node('frame', 0, 300, 180, 180)
  const a = node('rectangle', 8, 9, 20, 20), b = node('rectangle', 11, 12, 24, 16)
  frameA.children = [a.id]
  frameB.children = [b.id]
  doc.nodes = Object.fromEntries([frameA, frameB, target, a, b].map(item => [item.id, item]))
  doc.pages[0].children = [frameA.id, frameB.id, target.id]
  const editor = new Editor(doc)
  editors.push(editor)
  editor.select([a.id, b.id])
  editor.copy()
  editor.select([target.id])
  editor.pasteToSelection()
  expect(editor.state.selection).toHaveLength(2)
  expect(editor.state.selection.every(id => allParents(editor.state.doc).get(id) === target.id)).toBe(true)
  editor.undo()
  editor.update([frameA.id], { locked: true })
  editor.select([a.id, b.id])
  const locked = editor.state.doc
  editor.pasteToSelection()
  expect(editor.state.doc).toBe(locked)
  expect(editor.state.message).toContain('锁定')
})

test('paste in place of a rotated component keeps rotation on the new instance', () => {
  const doc = blank('component paste')
  const master = node('frame', 40, 50, 80, 60)
  const angle = Math.PI / 6
  master.transform = [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 40, 50]
  doc.nodes[master.id] = master
  doc.pages[0].children = [master.id]
  const editor = new Editor(doc)
  editors.push(editor)
  editor.select([master.id])
  editor.createComponent()
  const componentId = editor.state.selection[0]
  expect(editor.state.doc.nodes[componentId].component).toBeTruthy()
  const world = worldMatrix(editor.state.doc, componentId)
  editor.copy()
  editor.select([])
  editor.paste(true)
  const id = editor.state.selection[0]
  const inst = editor.state.doc.nodes[id]
  expect(inst.instance?.componentId).toBe(componentId)
  expect(allParents(editor.state.doc).get(id)).toBe(editor.state.page)
  worldMatrix(editor.state.doc, id).forEach((value, index) => expect(value).toBeCloseTo(world[index], 6))
  const host = node('frame', 220, 40, 360, 280)
  editor.change('host', d => { d.nodes[host.id] = host; d.pages[0].children.push(host.id) })
  editor.select([host.id])
  editor.paste(true)
  const nested = editor.state.selection[0]
  expect(editor.state.doc.nodes[nested].instance?.componentId).toBe(componentId)
  expect(allParents(editor.state.doc).get(nested)).toBe(host.id)
  worldMatrix(editor.state.doc, nested).forEach((value, index) => expect(value).toBeCloseTo(world[index], 6))
})

test('paste in place of a rotated component instance keeps its world transform', () => {
  const doc = blank('instance paste')
  const master = node('frame', 10, 20, 70, 40)
  doc.nodes[master.id] = master
  doc.pages[0].children = [master.id]
  const editor = new Editor(doc)
  editors.push(editor)
  editor.select([master.id])
  editor.createComponent()
  editor.duplicate()
  const instanceId = editor.state.selection[0]
  const angle = 0.7
  editor.update([instanceId], { transform: [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 120, 80] })
  const world = worldMatrix(editor.state.doc, instanceId)
  editor.copy()
  editor.paste(true)
  const id = editor.state.selection[0]
  expect(id).not.toBe(instanceId)
  expect(editor.state.doc.nodes[id].instance?.componentId).toBe(editor.state.doc.nodes[instanceId].instance?.componentId)
  worldMatrix(editor.state.doc, id).forEach((value, index) => expect(value).toBeCloseTo(world[index], 6))
  expect(editor.state.doc.nodes[instanceId].transform[0]).toBeCloseTo(Math.cos(angle), 6)
})

test('ordinary paste of a 30 degree instance keeps rotation', () => {
  const doc = blank('instance paste 30')
  const master = node('rectangle', 10, 20, 80, 40)
  doc.nodes[master.id] = master
  doc.pages[0].children = [master.id]
  const editor = new Editor(doc)
  editors.push(editor)
  editor.select([master.id])
  editor.createComponent()
  editor.duplicate()
  const instanceId = editor.state.selection[0]
  const angle = Math.PI / 6
  editor.update([instanceId], { transform: [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), -1.26, -2.21] })
  editor.copy()
  editor.paste()
  const copy = editor.state.doc.nodes[editor.state.selection[0]]
  expect(copy.instance?.componentId).toBe(editor.state.doc.nodes[instanceId].instance?.componentId)
  expect(copy.transform[0]).toBeCloseTo(Math.cos(angle), 6)
  expect(copy.transform[1]).toBeCloseTo(Math.sin(angle), 6)
  expect(copy.transform[2]).toBeCloseTo(-Math.sin(angle), 6)
  expect(copy.transform[3]).toBeCloseTo(Math.cos(angle), 6)
  expect(copy.transform[4]).toBeCloseTo(8.74, 6)
  expect(copy.transform[5]).toBeCloseTo(7.79, 6)
})
