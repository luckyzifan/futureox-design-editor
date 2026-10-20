// CPU-only React DOM + real Editor/WASM; no browser, GPU or socket stubs.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { blank, node } from './model'
import { createMain, insertInstance } from './components'
import { declareSlot } from './component-slots'
import { ComponentPanel } from './ComponentPanel'
const dom = await vi.hoisted(async () => {
  // @ts-expect-error jsdom is a test-only runtime dependency.
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLSelectElement', 'Event']) vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  return dom
})
test('shared Web/Electron ComponentPanel assigns and resets arbitrary content via real DOM events', async () => {
  const d = blank(), main = node('frame'), host = node('frame'), content = node('text')
  main.children = [host.id]; content.text = 'Free content'
  for (const n of [main, host, content]) d.nodes[n.id] = n
  d.pages[0].children = [main.id, content.id]
  createMain(d, [main.id], d.pages[0].id); declareSlot(d, host.id, 'Body', 'body'); d.schemaVersion = 15
  const id = insertInstance(d, main.id, d.pages[0].id, { x: 300, y: 0 })
  const editor = new Editor(d), mount = document.createElement('div'), root = createRoot(mount)
  document.body.append(mount)
  try {
    const render = () => root.render(<ComponentPanel editor={editor} node={editor.state.doc.nodes[id]} ids={[id]} />)
    await act(async () => render())
    const select = mount.querySelector('select[aria-label="向插槽 Body 添加内容"]') as HTMLSelectElement
    expect(select).not.toBeNull()
    await act(async () => { select.value = content.id; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); render() })
    expect(editor.state.doc.nodes[id].instance!.slotContents).toEqual({ body: [content.id] })
    const reset = [...mount.querySelectorAll('button')].find(b => b.textContent === '恢复默认')!
    await act(async () => { reset.click(); render() })
    expect(editor.state.doc.nodes[id].instance!.slotContents || {}).toEqual({})
    expect(editor.state.doc.pages[0].children).toContain(content.id)
  } finally { await act(async () => root.unmount()); mount.remove(); editor.dispose() }
})
