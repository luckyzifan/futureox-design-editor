// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { Inspector } from './Inspector'
import { Editor } from './engine'
import { PendingEditContext } from './pending-edit-context'
import { interfacePreference } from './interface-preference'
import { blank, defaultLayout, node, type Constraints, type Matrix } from './model'
import { selectionParentBounds } from './canvas-view'

let root: Root | undefined
let editor: Editor | undefined

beforeEach(() => interfacePreference.reset())
afterEach(async () => {
  await act(async () => root?.unmount())
  editor?.dispose()
  root = editor = undefined
  document.body.replaceChildren()
})

async function mount({ pins, transform, at = [20, 30], flow = false, uiMode = 'sketch' }: {
  pins?: Constraints; transform?: Matrix; at?: [number, number]; flow?: boolean; uiMode?: 'sketch' | 'figma'
} = {}) {
  interfacePreference.set({ uiMode })
  const doc = blank('Inspector pins')
  const parent = node('frame', 50, 60, 300, 200)
  const child = node('rectangle', at[0], at[1], 40, 50)
  if (pins) child.constraints = pins
  if (transform) child.transform = transform
  if (flow) parent.layout = { ...defaultLayout(), mode: 'horizontal' }
  parent.children = [child.id]
  doc.nodes = { [parent.id]: parent, [child.id]: child }
  doc.pages[0].children = [parent.id]
  const instance = editor = new Editor(doc)
  instance.select([child.id])
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<PendingEditContext.Provider value={instance}><Inspector editor={instance} /></PendingEditContext.Provider>))
  return { editor: instance, childId: child.id, constraints: () => instance.authoredDocument.nodes[child.id].constraints,
    bounds: () => selectionParentBounds(instance.state.doc, child.id) }
}

function pin(edge: string) {
  const button = document.querySelector<HTMLButtonElement>(`.constraint-box .edge-${edge}`)
  expect(button).not.toBeNull()
  return button!
}

async function click(target: Element, modifiers: MouseEventInit = {}) {
  await act(async () => target.dispatchEvent(new MouseEvent('click', { bubbles: true, ...modifiers })))
}

function pressed() {
  return ['left', 'right', 'top', 'bottom'].filter(edge => pin(edge).getAttribute('aria-pressed') === 'true')
}

async function menuItem(label: string) {
  await act(async () => pin('left').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })))
  const target = [...document.querySelectorAll('[role="menuitem"]')].find(element => element.textContent === label)
  expect(target).toBeDefined()
  await click(target!)
}

async function setDimension(label: 'W' | 'H', input: string) {
  const field = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  await act(async () => {
    field.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, input)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
}

test('Sketch edges reflect authored pins and Option switches or clears the axis', async () => {
  const model = await mount()
  expect(model.constraints()).toBeUndefined()
  expect(pressed()).toEqual([])
  await click(pin('left'))
  expect(pressed()).toEqual(['left'])
  expect(model.constraints()).toMatchObject({ horizontal: 'start', vertical: 'center' })
  await click(pin('right'), { altKey: true })
  expect(pressed()).toEqual(['right'])
  await click(pin('right'))
  expect(pressed()).toEqual([])
  expect(model.constraints()).toBeUndefined()
  await click(pin('right'), { altKey: true })
  expect(pressed()).toEqual(['left', 'right'])
  await click(pin('left'), { altKey: true })
  expect(pressed()).toEqual([])
  await click(pin('top'))
  await click(pin('bottom'))
  expect(pressed()).toEqual(['top', 'bottom'])
  await click(pin('top'), { shiftKey: true })
  expect(pressed()).toEqual(['bottom'])
})

test('Sketch Auto Pin reuses the selection command and pin menu edits undo in one step', async () => {
  const model = await mount({ at: [246, 137] })
  const revision = model.editor.state.version
  expect(pin('center').getAttribute('aria-label')).toBe('自动固定选区')
  await click(pin('center'))
  expect(model.editor.state.version).toBe(revision + 1)
  expect(pressed()).toEqual(['right', 'bottom'])
  await click(pin('center'))
  expect(model.constraints()).toBeUndefined()
  await menuItem('恢复默认钉扎')
  expect(pressed()).toEqual(['left', 'top'])
  expect(model.constraints()).toMatchObject({ horizontal: 'start', vertical: 'start' })
  await menuItem('钉扎全部边')
  expect(pressed()).toEqual(['left', 'right', 'top', 'bottom'])
  await act(async () => model.editor.undo())
  expect(pressed()).toEqual(['left', 'top'])
  await menuItem('取消全部钉扎')
  expect(model.constraints()).toBeUndefined()
  expect(pressed()).toEqual([])
  await menuItem('自动固定选区')
  expect(pressed()).toEqual(['right', 'bottom'])
})

test('Figma keeps its existing default and Shift transitions', async () => {
  const model = await mount({ uiMode: 'figma' })
  expect(pressed()).toEqual(['left', 'top'])
  await click(pin('right'), { shiftKey: true })
  expect(model.constraints()?.horizontal).toBe('stretch')
  expect(pressed()).toEqual(['left', 'right', 'top'])
  await click(pin('center'))
  expect(pin('center').getAttribute('aria-pressed')).toBe('true')
})

test('Sketch fixed children can keep their width when switching to relative in a plain frame', async () => {
  const model = await mount()
  const width = document.querySelector<HTMLSelectElement>('select[aria-label="宽度模式"]')!
  expect(width.querySelector<HTMLOptionElement>('option[value="relative"]')?.disabled).toBe(false)
  await act(async () => {
    width.value = 'relative'
    width.dispatchEvent(new Event('change', { bubbles: true }))
  })
  const edited = model.editor.authoredDocument.nodes[model.childId]
  expect(edited.sizing).toMatchObject({ width: 'relative', widthRatio: 40 / 300 })
  expect(edited.width).toBe(40)
  expect(edited.constraints).toBeUndefined()
})

test('Figma plain frames keep the existing ordinary sizing choices', async () => {
  await mount({ uiMode: 'figma' })
  const width = document.querySelector<HTMLSelectElement>('select[aria-label="宽度模式"]')!
  expect(width.querySelector('option[value="relative"]')).toBeNull()
})

test.each([
  { label: 'W' as const, value: '80', pins: { horizontal: 'end', vertical: 'center' } as const, change: { x: -20, width: 80 } },
  { label: 'H' as const, value: '100', pins: { horizontal: 'center', vertical: 'end' } as const, change: { y: -20, height: 100 } },
  { label: 'W' as const, value: '80', pins: { horizontal: 'start', vertical: 'center' } as const, change: { x: 20, width: 80 } },
  { label: 'W' as const, value: '80l', pins: { horizontal: 'end', vertical: 'center' } as const, change: { x: 20, width: 80 } },
])('Sketch $label=$value preserves the appropriate edge and undoes once', async ({ label, value, pins, change }) => {
  const model = await mount({ pins })
  const before = model.bounds()
  await setDimension(label, value)
  expect(model.bounds()).toEqual({ ...before, ...change })
  await act(async () => model.editor.undo())
  expect(model.bounds()).toEqual(before)
  expect(model.editor.canUndo).toBe(false)
})

test('Sketch uses the parent-space right edge of a mirrored child', async () => {
  const model = await mount({ transform: [-1, 0, 0, 1, 60, 30], pins: { horizontal: 'end', vertical: 'center' } })
  expect(model.bounds().x).toBe(20)
  await setDimension('W', '80')
  expect(model.bounds()).toMatchObject({ x: -20, width: 80 })
})

test('Sketch leaves flow placement under stack control', async () => {
  const model = await mount({ flow: true, pins: { horizontal: 'end', vertical: 'end' } })
  const before = model.bounds()
  await setDimension('W', '80')
  expect(model.bounds()).toEqual({ ...before, width: 80 })
})
