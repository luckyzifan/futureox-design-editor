// Draw mode makes layer rows taller. The virtual window must stay on the rows,
// and the document camera must stay put. jsdom + Editor, not a GPU measurement.
// @ts-expect-error jsdom runtime dependency
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { resetFigmaWorkspaceMode, setFigmaWorkspaceMode } from './figma-workspace-mode'
import { Layers } from './Layers'
import { Editor } from './engine'
import { interfacePreference } from './interface-preference'
import { blank, node, paint } from './model'

test('switching Design and Draw keeps the layer window, document, and camera', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://design.invalid/' })
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'localStorage'] as const)
    vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  interfacePreference.reset()
  resetFigmaWorkspaceMode()
  interfacePreference.set({ uiMode: 'figma', locale: 'zh-CN' })
  const doc = blank('bench')
  const ids: string[] = []
  for (let index = 0; index < 400; index++) {
    const shape = node(index % 5 === 0 ? 'ellipse' : index % 7 === 0 ? 'text' : 'rectangle', (index % 20) * 40, Math.floor(index / 20) * 30, 36, 24)
    shape.name = `Layer ${index}`
    shape.fills = [paint(index % 2 === 0 ? '#3366cc' : '#e26d5a')]
    doc.nodes[shape.id] = shape
    ids.push(shape.id)
  }
  doc.pages[0].children = ids
  const editor = new Editor(doc)
  const root: Root = createRoot(document.getElementById('root')!)
  await act(async () => { root.render(<Layers editor={editor} showPages={false} />) })
  await act(async () => { editor.select([ids[0]]) })
  const view = editor.state.view
  const selection = editor.state.selection
  expect(document.querySelectorAll('.layer-row').length).toBeGreaterThan(10)
  expect(document.querySelector('[data-layer-preview]')).toBeNull()
  await act(async () => setFigmaWorkspaceMode('draw'))
  const previews = document.querySelectorAll('[data-layer-preview]').length
  expect(previews).toBeGreaterThan(10)
  expect(previews).toBe(document.querySelectorAll('.layer-row').length)
  expect(editor.state.doc).toBe(doc)
  expect(editor.state.view).toBe(view)
  expect(editor.state.selection).toBe(selection)
  await act(async () => setFigmaWorkspaceMode('design'))
  expect(document.querySelectorAll('.layer-row').length).toBeGreaterThan(10)
  expect(document.querySelector('[data-layer-preview]')).toBeNull()
  expect(editor.state.doc).toBe(doc)
  expect(editor.state.view).toBe(view)
  expect(editor.state.selection).toBe(selection)
  resetFigmaWorkspaceMode()
  await act(async () => root.unmount())
  editor.dispose()
  interfacePreference.reset()
  dom.window.close()
})
