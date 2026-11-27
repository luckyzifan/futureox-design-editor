// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { PageList } from './PageList'
import { Editor } from './engine'
import { interfacePreference } from './interface-preference'
import { blank } from './model'
import { userPages } from './fig-document'

let dom: JSDOM, root: Root, mount: HTMLElement, editor: Editor
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'Node', 'Event', 'KeyboardEvent', 'localStorage'])
    vi.stubGlobal(name, name === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  interfacePreference.reset()
  interfacePreference.set({ uiMode: 'sketch', locale: 'zh-CN' })
  editor = new Editor(blank('Pages'))
  editor.addPage()
  editor.switchPage(userPages(editor.state.doc)[0].id)
  mount = document.createElement('div')
  document.body.append(mount)
  root = createRoot(mount)
})
afterEach(async () => {
  await act(async () => root.unmount())
  editor.dispose()
  interfacePreference.reset()
  dom.window.close()
  vi.unstubAllGlobals()
})

async function renderPages() {
  await act(async () => { root.render(<PageList editor={editor} onRename={() => {}} />) })
  return [...document.querySelectorAll<HTMLButtonElement>('button.page')]
}
function pageKey(target: EventTarget, key: 'PageUp' | 'PageDown') {
  const event = new dom.window.KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

test('Fn↑/Fn↓ (PageUp/PageDown) switch pages while focus is in the Sketch page list', async () => {
  const pages = userPages(editor.state.doc)
  const rows = await renderPages()
  expect(rows).toHaveLength(2)
  expect(editor.state.page).toBe(pages[0].id)

  let event: Event
  await act(async () => { event = pageKey(rows[0], 'PageDown') })
  expect(event!.defaultPrevented).toBe(true)
  expect(editor.state.page).toBe(pages[1].id)

  await act(async () => { pageKey(rows[1], 'PageUp') })
  expect(editor.state.page).toBe(pages[0].id)
  expect(editor.state.page).toBe(editor.state.doc.pages[0].id)
})

test('Figma layout leaves page keys to its own bindings', async () => {
  interfacePreference.set({ uiMode: 'figma' })
  const pages = userPages(editor.state.doc)
  const rows = await renderPages()
  const event = pageKey(rows[0], 'PageDown')
  await act(async () => {})
  expect(event.defaultPrevented).toBe(false)
  expect(editor.state.page).toBe(pages[0].id)
})