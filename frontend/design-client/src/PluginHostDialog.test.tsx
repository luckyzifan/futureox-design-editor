// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Editor } from './engine'
import { blank } from './model'
import { PluginHostDialog } from './PluginHostDialog'

let dom: JSDOM, root: Root, editor: Editor
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://design.invalid/' })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement)
  vi.stubGlobal('MouseEvent', dom.window.MouseEvent)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  editor = new Editor(blank('Plugin dialog'))
  root = createRoot(document.getElementById('root')!)
})
afterEach(async () => {
  await act(async () => root.unmount())
  editor.dispose()
  dom.window.close()
  vi.unstubAllGlobals()
})

it('runs the sample from the plugins panel', async () => {
  await act(async () => { root.render(<PluginHostDialog editor={editor} onClose={() => {}} />) })
  const button = document.querySelector<HTMLButtonElement>('[data-testid="plugin-run-sample"]')
  expect(button?.textContent).toContain('运行示例')
  expect(document.body.textContent).toContain('figma.createRectangle')
  await act(async () => { button?.click() })
  await vi.waitFor(() => {
    expect(Object.values(editor.state.doc.nodes).some(node => node.name === 'Plugin sample')).toBe(true)
  }, { timeout: 20_000 })
  expect(document.body.textContent).toContain('Sample plugin created a frame')
})
