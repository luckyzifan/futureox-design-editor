// Mounted React / Editor regression. Native rendering is verified separately.
// @ts-expect-error jsdom runtime dependency
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Layers } from './Layers'
import { Editor } from './engine'
import { blank, node } from './model'

const bootstrap = await vi.hoisted(async () => {
  // @ts-expect-error jsdom runtime dependency
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<html><body></body></html>')
  for (const key of ['window', 'document', 'navigator']) vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key])
  return dom
})
bootstrap.window.close()
let dom: any, root: Root, editor: Editor
beforeEach(async () => {
  dom = new JSDOM('<div id="root"></div>', { url: 'https://design.invalid' })
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'localStorage'])
    vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {})
  const doc = blank(), a = node('rectangle'), b = node('rectangle')
  a.name = '入库'; b.name = '控件'
  doc.nodes[a.id] = a; doc.nodes[b.id] = b
  doc.pages[0].children = [a.id]
  doc.pages.push({ ...doc.pages[0], id: 'f39cec26-ef11-44ae-bf82-ff4a77701201', name: '控件', children: [b.id] })
  editor = new Editor(doc); root = createRoot(document.getElementById('root')!)
  await act(async () => root.render(<Layers editor={editor} showPages={false} />))
})
afterEach(async () => { await act(async () => root.unmount()); editor.dispose(); dom.window.close(); vi.unstubAllGlobals() })
const search = () => document.querySelector<HTMLInputElement>('[aria-label="搜索图层"]')!
async function query() {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search(), '入库')
    search().dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(search().value).toBe('入库')
}
test('page switching clears the previous filter and exposes the new page layers', async () => {
  await query()
  const list = document.querySelector<HTMLElement>('.layer-list')!; list.scrollTop = 700
  await act(async () => editor.set({ page: editor.state.doc.pages[1].id, selection: [] }))
  expect(search().value).toBe('')
  expect(list.scrollTop).toBe(0)
  expect(document.querySelector('[role="tree"]')!.textContent).toContain('控件')
})
test('replacing a workset with the same page identity clears its obsolete filter', async () => {
  await query()
  const next = structuredClone(editor.state.doc)
  next.nodes[next.pages[0].children[0]].name = '新工作集'
  await act(async () => { expect(editor.load(next)).toBe(true) })
  expect(search().value).toBe('')
  expect(document.querySelector('[role="tree"]')!.textContent).toContain('新工作集')
})
test('camera and selection updates within the same page retain the search', async () => {
  await query()
  await act(async () => editor.set({ view: { x: 500, y: -200, zoom: 32 }, selection: [editor.state.doc.pages[0].children[0]] }))
  expect(search().value).toBe('入库')
})
