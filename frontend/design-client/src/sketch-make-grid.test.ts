import { afterEach, expect, test } from 'vitest'
import { insertInstance, stampKeys } from './components'
import { Editor } from './engine'
import { interfacePreference } from './interface-preference'
import { blank, effect, node, paint } from './model'
import { applySketchGrid, bindMakeGridDialog, canMakeSketchGrid, requestMakeGrid, type MakeGridTarget } from './sketch-make-grid'

const editors: Editor[] = []
afterEach(() => {
  editors.splice(0).forEach(editor => editor.dispose())
  interfacePreference.set({ uiMode: 'figma' })
})

function openGrid(editor: Editor): MakeGridTarget {
  let target: MakeGridTarget | undefined
  const unbind = bindMakeGridDialog(editor, selected => { target = selected })
  requestMakeGrid(editor)
  unbind()
  expect(target).toBeDefined()
  return target!
}

test('Make Grid keeps existing cells and copies the last selected subtree into empty cells', () => {
  interfacePreference.set({ uiMode: 'sketch' })
  const doc = blank('Grid'), first = node('rectangle', 30, 40, 40, 30)
  const template = node('group', 90, 40, 40, 30), child = node('rectangle', 0, 0, 40, 30)
  first.fills = [paint('#111111')]
  child.fills = [paint('#3672a5')]
  child.effects = [effect('shadow')]
  template.children = [child.id]
  for (const layer of [first, template, child]) doc.nodes[layer.id] = layer
  doc.pages[0].children = [first.id, template.id]
  const editor = new Editor(doc)
  editors.push(editor)
  editor.select([first.id, template.id])
  const before = editor.authoredDocument
  const target = openGrid(editor)
  expect(target.source.existing).toMatchObject({ rows: 1, columns: 2, gapX: 20 })
  expect(applySketchGrid(editor, target, { rows: 2, columns: 3, gapX: 12, gapY: 9 })?.status).toBe('committed')
  const { selection } = editor.state
  expect(selection.slice(0, 2)).toEqual([first.id, template.id])
  expect(selection.map(id => editor.state.doc.nodes[id].transform.slice(4))).toEqual([
    [30, 40], [82, 40], [134, 40], [30, 79], [82, 79], [134, 79],
  ])
  for (const id of selection.slice(2)) {
    const parent = editor.state.doc.nodes[id]
    expect(parent.kind).toBe('group')
    expect(editor.state.doc.nodes[parent.children[0]]).toMatchObject({ fills: child.fills, effects: child.effects })
  }
  expect(editor.state.doc.nodes[child.id]).toEqual(before.nodes[child.id])
  editor.undo()
  expect(editor.authoredDocument).toEqual(before)
  expect(editor.canUndo).toBe(false)
})

test('Make Grid respects lock and instance boundaries and rejects stale targets', () => {
  interfacePreference.set({ uiMode: 'sketch' })
  const doc = blank('Grid ownership'), master = node('frame', 90, 40, 60, 60)
  const child = node('rectangle', 0, 0, 40, 30), locked = node('rectangle', 20, 40, 40, 30)
  master.component = { variants: {}, properties: {} }
  master.children = [child.id]
  locked.locked = true
  for (const layer of [master, child, locked]) doc.nodes[layer.id] = layer
  doc.pages[0].children = [locked.id, master.id]
  stampKeys(doc, master.id)
  const instance = insertInstance(doc, master.id, doc.pages[0].id, { x: 300, y: 40 })
  const editor = new Editor(doc)
  editors.push(editor)
  editor.select([locked.id])
  expect(canMakeSketchGrid(editor)).toBe(false)
  editor.select([editor.state.doc.nodes[instance].children[0]])
  expect(canMakeSketchGrid(editor)).toBe(false)

  editor.select([master.id])
  const target = openGrid(editor), before = editor.authoredDocument
  editor.select([instance])
  expect(applySketchGrid(editor, target, { rows: 2, columns: 2, gapX: 10, gapY: 10 })).toBeUndefined()
  expect(editor.authoredDocument).toBe(before)
  expect(editor.canUndo).toBe(false)
})
