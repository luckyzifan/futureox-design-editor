// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'
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

async function mount(grid: boolean) {
  const doc = blank('Grid compatibility')
  const frame = node('frame', 40, 50, 100, 100)
  const coordinates = grid ? [[4, 5], [2, 3], [6, 7]] : [[10, 10], [30, 10], [10, 30], [30, 30]]
  const children = coordinates.map(([x, y]) => node('rectangle', x, y, 10, 10))
  if (grid) frame.layout = { ...defaultLayout(), mode: 'grid', columns: 2, gap: 8, lineGap: 4, padding: [0, 0, 0, 0] }
  frame.children = children.map(child => child.id)
  doc.pages[0].children = [frame.id]
  doc.nodes = Object.fromEntries([frame, ...children].map(item => [item.id, item]))
  const instance = editor = new Editor(doc)
  instance.select([frame.id])
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<PendingEditContext.Provider value={instance}><Inspector editor={instance} /></PendingEditContext.Provider>))
  return { editor: instance, frame, children }
}

const switchMode = async (uiMode: 'sketch' | 'figma') => act(async () => interfacePreference.set({ uiMode }))
const gridDirection = () => document.querySelector('[role="radio"][aria-label="网格布局"]')
const gridOption = () => document.querySelector('select[aria-label="排列方式"] option[value="grid"]')

test('Sketch offers horizontal and vertical directions and preserves an existing Figma grid', async () => {
  await switchMode('figma')
  const { editor, frame, children } = await mount(true)
  const initial = editor.authoredDocument
  const coordinates = () => children.map(({ id }) => editor.state.doc.nodes[id].transform.slice(4))
  expect(gridDirection()?.getAttribute('aria-checked')).toBe('true')
  expect(gridOption()).not.toBeNull()
  expect(coordinates()).toEqual([[0, 0], [54, 0], [0, 14]])

  await switchMode('sketch')
  expect(document.querySelector('[role="radio"][aria-label="横向布局"]')).not.toBeNull()
  expect(document.querySelector('[role="radio"][aria-label="纵向布局"]')).not.toBeNull()
  expect(gridDirection()).toBeNull()
  expect(gridOption()).toBeNull()
  expect(document.querySelector('.layout-panel')?.textContent).toContain('网格以当前位置导出')
  expect(editor.authoredDocument).toBe(initial)

  await switchMode('figma')
  expect(gridDirection()?.getAttribute('aria-checked')).toBe('true')
  expect(editor.authoredDocument.nodes[frame.id].layout?.mode).toBe('grid')
  expect(coordinates()).toEqual([[0, 0], [54, 0], [0, 14]])
})

test('Sketch suggestions offer wrapped rows for grid-shaped geometry', async () => {
  await switchMode('sketch')
  const { editor, frame } = await mount(false)
  const show = Array.from(document.querySelectorAll('button')).find(el => el.textContent === '建议自动布局…')!
  await act(async () => show.click())
  const preview = document.querySelector('[role="region"][aria-label="建议布局预览"]')!
  const proposals = Array.from(preview.querySelectorAll('button')).filter(el => el.textContent === '应用此方案')
  expect(proposals).toHaveLength(1)
  await act(async () => proposals[0].click())
  expect(editor.authoredDocument.nodes[frame.id].layout).toMatchObject({ mode: 'horizontal', wrap: true })
})
