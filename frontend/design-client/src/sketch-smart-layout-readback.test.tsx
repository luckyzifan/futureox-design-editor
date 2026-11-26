// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { emptySystem } from './design-system'
import { Editor } from './engine'
import { Inspector } from './Inspector'
import { interfacePreference } from './interface-preference'
import { blank, defaultLayout, node } from './model'
import { PendingEditContext } from './pending-edit-context'

let root: Root | undefined
let editor: Editor | undefined

beforeEach(() => interfacePreference.reset())
afterEach(async () => {
  await act(async () => root?.unmount())
  editor?.dispose()
  root = editor = undefined
  document.body.replaceChildren()
})

async function mount(receipt: string, active = false) {
  interfacePreference.set({ uiMode: 'sketch' })
  const doc = blank('Smart Layout readback')
  doc.schemaVersion = 4
  const group = node('group', 16, 20, 213, 79)
  group.name = 'Links'
  if (active) group.layout = { ...defaultLayout(), mode: 'vertical' }
  doc.nodes[group.id] = group
  doc.pages[0].children = [group.id]
  doc.designSystem = { ...emptySystem(), sketchContainers: { nodeMetadata: {
    [group.id]: { bindings: { sketchInferredGroupLayout: receipt } },
  } } }
  const instance = editor = new Editor(doc)
  instance.select([group.id])
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<PendingEditContext.Provider value={instance}><Inspector editor={instance} /></PendingEditContext.Provider>))
  return instance
}

const source = (axis: number, layoutAnchor: number) => JSON.stringify({
  _class: 'MSImmutableInferredGroupLayout', axis, layoutAnchor, minSize: 0, maxSize: 0,
})
const readout = () => document.querySelector('[data-testid="sketch-legacy-smart-layout"]')

test('Sketch Inspector displays the saved Smart Layout direction and anchor without changing the document', async () => {
  const instance = await mount(source(0, 0))
  const original = instance.authoredDocument
  expect(readout()?.textContent).toContain('横向')
  expect(readout()?.textContent).toContain('左侧')
  expect(document.querySelector('[role="radio"][aria-label="自由布局"]')).toBeNull()
  expect(document.querySelector('[role="radio"][aria-label="纵向布局"]')).not.toBeNull()

  await act(async () => interfacePreference.set({ uiMode: 'figma' }))
  expect(readout()).toBeNull()
  expect(instance.authoredDocument).toBe(original)
})

test('Sketch displays a vertical legacy end anchor in English', async () => {
  await mount(source(1, 2))
  await act(async () => interfacePreference.set({ locale: 'en' }))
  expect(readout()?.textContent).toContain('Vertical')
  expect(readout()?.textContent).toContain('Bottom')
})

test.each([
  ['malformed receipt', '{', false],
  ['unsupported anchor', source(0, 12), false],
  ['active Stack', source(0, 0), true],
] as const)('Sketch skips the Smart Layout readback for a %s', async (_, receipt, active) => {
  await mount(receipt, active)
  expect(readout()).toBeNull()
  expect(document.querySelector('[role="radio"][aria-label="自由布局"]')).not.toBeNull()
})
