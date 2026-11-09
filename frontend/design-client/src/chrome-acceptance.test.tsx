// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { Editor } from './engine'
import { blank } from './model'
import { Layers } from './Layers'
import { displayColorHex } from './color'
import { canvasStatusLabel } from './canvas-status-label'
import { createInterfacePreference } from './interface-preference'
import { DesignAgentDock } from './design-ai/DesignAgentDock'
import DesignAgentPanel from './design-ai/DesignAgentPanel'
import { openAgentDock, resetAgentDockForTests } from './design-ai/design-agent-dock'

let root: Root | undefined
beforeEach(() => {
  Element.prototype.scrollTo = () => {}
  if (typeof globalThis.ResizeObserver !== 'function') {
    globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as typeof ResizeObserver
  }
})
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; resetAgentDockForTests() })

function memory() {
  const bag = new Map<string, string>()
  return { getItem: (key: string) => bag.get(key) ?? null, setItem: (key: string, value: string) => { bag.set(key, value) } }
}

test('Figma and Sketch layouts persist', () => {
  const storage = memory()
  const prefs = createInterfacePreference(() => storage)
  expect(prefs.getSnapshot().uiMode).toBe('figma')
  prefs.set({ uiMode: 'sketch' })
  expect(createInterfacePreference(() => storage).getSnapshot().uiMode).toBe('sketch')
  prefs.set({ uiMode: 'figma' })
  expect(createInterfacePreference(() => storage).getSnapshot().uiMode).toBe('figma')
})

test('the design assistant dock is not a modal and prefills from a page target', async () => {
  const editor = new Editor(blank('页面'))
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const pageId = editor.state.page
  await act(async () => { root!.render(<DesignAgentDock editor={editor} />) })
  const dock = document.getElementById('design-agent-dock')!
  expect(dock.hidden).toBe(true)
  expect(document.querySelector('.modal-backdrop,[aria-modal="true"]')).toBeNull()
  await act(async () => { openAgentDock({ pageId, prompt: '细节调整：修改「页面」', send: false }) })
  expect(dock.hidden).toBe(false)
  expect(document.querySelector('.modal-backdrop,[aria-modal="true"],.page-ai-pop')).toBeNull()
  expect(document.querySelector('textarea')!.value).toContain('细节调整')
  editor.dispose()
})

test('a mounted assistant panel stays a side panel when the prompt is only prefilled', async () => {
  const editor = new Editor(blank('页面'))
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<DesignAgentPanel editor={editor} onClose={() => {}} initial={{ pageId: editor.state.page, prompt: '秋日特惠', send: false }} />)
  })
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(document.querySelector('textarea')!.value).toBe('秋日特惠')
  editor.dispose()
})

test('the left sidebar keeps page actions and the layer footer outside the scrolling list', async () => {
  const doc = blank('未命名')
  doc.pages[0].name = 'Meher Admin Dashboard Ui Kit Light'
  const editor = new Editor(doc)
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(<Layers editor={editor} />) })
  const page = document.querySelector('.page-name')!
  expect(page.textContent).toContain('Meher Admin Dashboard')
  expect(page.getAttribute('title')).toContain('Meher Admin Dashboard')
  expect(document.body.textContent).toContain('删除页面')
  expect(document.querySelector('.layer-footer')!.textContent).toContain('编组')
  expect(document.querySelector('.layer-footer')!.textContent).toContain('复制')
  const count = document.querySelector('.layer-heading > span')!
  expect(count.textContent).toMatch(/^\d+$/)
  expect(count.getAttribute('title')).toBe(count.textContent)
  const css = readFileSync(join(process.cwd(), 'src/styles.css'), 'utf8')
  expect(css).toContain('.layers-tabpanel[hidden] { display: none !important; }')
  expect(css).toContain('.layer-footer { flex: none; }')
  expect(css).not.toContain('.file-menu { top: 48px; left: 10px;')
  expect(css).toContain('bottom: 78px')
  editor.dispose()
})

test('opaque srgb page color and memory errors are display strings, not raw engine text', () => {
  expect(displayColorHex('color(srgb 0.949019610 0.949019610 0.949019610)')).toBe('#F2F2F2')
  expect(canvasStatusLabel('The document exceeds the available WASM memory allowance. Close other documents or use a machine with more memory.')).toBe('内存不足，当前画面已保留')
})
