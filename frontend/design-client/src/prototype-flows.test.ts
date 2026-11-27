import { expect, test } from 'vitest'
import { Editor } from './engine'
import { blank, node, validateDocument } from './model'
import { initialPrototype } from './prototype'
import { addPrototypeFlow, prototypeFlowsOnPage, removePrototypeFlow, updatePrototypeFlow } from './prototype-flows'

function fixture() {
  const doc = blank()
  const [first, second, third] = [node('frame'), node('frame'), node('frame')]
  doc.nodes = { [first.id]: first, [second.id]: second, [third.id]: third }
  doc.pages[0].children = [first.id, second.id, third.id]
  return { doc, page: doc.pages[0].id, first: first.id, second: second.id, third: third.id }
}

test('named flows preserve the legacy default, support rename and move, and play at the chosen frame', () => {
  const { doc, page, first, second, third } = fixture()
  doc.schemaVersion = 4
  doc.prototype = { startNode: first, interactions: {} }
  const editor = new Editor(doc)
  editor.change('Add a second start', draft => addPrototypeFlow(draft, page, second))
  expect(editor.state.doc.schemaVersion).toBe(35)
  const flows = () => prototypeFlowsOnPage(editor.state.doc, page)
  expect(flows().map(flow => flow.startNode)).toEqual([first, second])
  expect(initialPrototype(editor.state.doc, second, page).current).toBe(second)
  editor.change('Rename the old start', draft => updatePrototypeFlow(draft, page, '', { name: 'Browse' }))
  expect(initialPrototype(editor.state.doc).current).toBe(first)
  expect(flows()[0]).toMatchObject({ name: 'Browse', startNode: first })
  const id = flows()[1].id
  editor.change('Move the second start', draft => updatePrototypeFlow(draft, page, id, { startNode: third }))
  expect(flows()[1]).toMatchObject({ id, startNode: third })
  editor.change('Delete the flow', draft => removePrototypeFlow(draft, page, id))
  expect(flows()).toHaveLength(1)
  editor.undo()
  expect(flows()[1].startNode).toBe(third)
  editor.dispose()
})

test('duplicate remaps flow identities and frame deletion prunes only the affected start', () => {
  const { doc, page, first, second } = fixture()
  const editor = new Editor(doc)
  editor.change('Two starts', draft => {
    addPrototypeFlow(draft, page, first)
    addPrototypeFlow(draft, page, second)
  })
  editor.select([first])
  editor.duplicate()
  const duplicate = editor.state.selection[0]
  expect(duplicate).not.toBe(first)
  const flows = () => prototypeFlowsOnPage(editor.state.doc, page)
  expect(flows().map(flow => flow.startNode)).toEqual([first, second, duplicate])
  expect(new Set(flows().map(flow => flow.id)).size).toBe(3)
  editor.remove()
  expect(flows().map(flow => flow.startNode)).toEqual([first, second])
  editor.undo()
  expect(flows().map(flow => flow.startNode)).toEqual([first, second, duplicate])
  editor.dispose()
})

test('document admission rejects older schemas and duplicate or missing flow starts', () => {
  const { doc, page, first, second } = fixture()
  addPrototypeFlow(doc, page, first)
  addPrototypeFlow(doc, page, second)
  expect(() => validateDocument(doc)).toThrow(/35/)
  doc.schemaVersion = 35
  expect(validateDocument(doc).prototype?.flows).toHaveLength(2)
  doc.prototype!.flows![1].startNode = first
  expect(() => validateDocument(doc)).toThrow(/原型流程/)
  doc.prototype!.flows![1].startNode = 'missing'
  expect(() => validateDocument(doc)).toThrow(/原型流程/)
})
