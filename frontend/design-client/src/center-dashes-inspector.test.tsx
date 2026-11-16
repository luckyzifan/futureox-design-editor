// @ts-expect-error jsdom runtime dependency
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Inspector } from './Inspector'
import { PendingEditContext } from './pending-edit-context'
import { interfacePreference } from './interface-preference'
import { Editor } from './engine'
import { blank, node, stroke } from './model'

const bootstrap = await vi.hoisted(async () => {
  // @ts-expect-error jsdom runtime dependency
  const { JSDOM } = await import('jsdom')
  const d = new JSDOM('<!doctype html><html><body></body></html>')
  for (const key of ['window', 'document', 'navigator']) vi.stubGlobal(key, key === 'window' ? d.window : d.window[key])
  return d
})
bootstrap.window.close()

let dom: JSDOM, root: Root, mount: HTMLDivElement, editor: Editor
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Element', 'Event', 'MouseEvent', 'localStorage']) {
    vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key])
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  interfacePreference.reset()
  mount = document.createElement('div')
  document.body.append(mount)
  root = createRoot(mount)
})
afterEach(async () => {
  await act(async () => root.unmount())
  editor?.dispose()
  dom.window.close()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  interfacePreference.reset()
})

test('inspector toggles corner centering and undo keeps dash, cap and join', async () => {
  const layer = node('rectangle')
  layer.strokes = [{ ...stroke(), dash: '8 5', cap: 'butt', join: 'miter', width: 2 }]
  const doc = blank('center dashes')
  doc.nodes = { [layer.id]: layer }
  doc.pages[0].children = [layer.id]
  editor = new Editor(doc)
  editor.select([layer.id])
  await act(async () => {
    root.render(<PendingEditContext.Provider value={editor}><Inspector editor={editor} /></PendingEditContext.Provider>)
  })
  const box = mount.querySelector<HTMLInputElement>('input[aria-label="在拐角居中"]')
  expect(box).not.toBeNull()
  expect(box!.checked).toBe(false)
  const before = editor.state.doc
  await act(async () => { box!.click() })
  const edited = editor.state.doc.nodes[layer.id].strokes[0]
  expect(edited, JSON.stringify({ version: editor.state.version, message: editor.state.message, checked: box!.checked, stroke: edited })).toMatchObject({ dash: '8 5', cap: 'butt', join: 'miter', width: 2, centerDashes: true })
  expect(editor.state.version).toBe(1)
  await act(async () => editor.undo())
  expect(editor.state.doc).toEqual(before)
  expect(editor.state.doc.nodes[layer.id].strokes[0].centerDashes).toBeUndefined()
  await act(async () => editor.redo())
  expect(editor.state.doc.nodes[layer.id].strokes[0].centerDashes).toBe(true)
  expect(editor.state.doc.nodes[layer.id].strokes[0]).toMatchObject({ dash: '8 5', cap: 'butt', join: 'miter' })

  await act(async () => { interfacePreference.set({ locale: 'en' }) })
  expect(mount.querySelector('input[aria-label="Center on corners"]')).not.toBeNull()
  expect(mount.textContent).toContain('Center on corners')
})
