// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { blank, node } from './model'
import { Layers } from './Layers'
import { displayColorHex } from './color'
import { canvasStatusLabel } from './canvas-status-label'
import { createInterfacePreference, interfacePreference } from './interface-preference'
import { Inspector } from './Inspector'
import { PendingEditContext } from './pending-edit-context'
import { DesignAgentDock } from './design-ai/DesignAgentDock'
import DesignAgentPanel from './design-ai/DesignAgentPanel'
import { openAgentDock, resetAgentDockForTests } from './design-ai/design-agent-dock'

let root: Root | undefined
beforeEach(() => {
  interfacePreference.reset()
  Element.prototype.scrollTo = () => {}
  if (typeof globalThis.ResizeObserver !== 'function') {
    globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as typeof ResizeObserver
  }
})
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; resetAgentDockForTests(); vi.unstubAllGlobals() })

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

test('page resizing, collapse and targeted deletion leave the layer tree available', async () => {
  const doc = blank('未命名')
  doc.pages[0].name = 'Meher Admin Dashboard Ui Kit Light'
  const disposable = { ...blank().pages[0], name: 'Disposable' }
  doc.pages.push(disposable)
  const editor = new Editor(doc)
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(<Layers editor={editor} />) })
  const page = document.querySelector('.page-name')!
  expect(page.textContent).toContain('Meher Admin Dashboard')
  expect(page.getAttribute('title')).toContain('Meher Admin Dashboard')
  const pane = document.querySelector<HTMLDivElement>('.page-list-body')!
  const splitter = document.querySelector('[role="separator"]')!
  await act(async () => splitter.dispatchEvent(new KeyboardEvent('keydown', { key:'ArrowDown', bubbles:true })))
  expect(pane.style.height).toBe('225px')
  const disclosure = document.querySelector<HTMLButtonElement>('.pages-current')!
  await act(async () => disclosure.click())
  expect(pane.hidden).toBe(true)
  expect(disclosure.textContent).toContain('Meher Admin Dashboard')
  expect(document.querySelector('[role="tree"]')).not.toBeNull()
  await act(async () => disclosure.click())
  expect(pane.style.height).toBe('225px')
  vi.stubGlobal('confirm', () => true)
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label$="Disposable"].page-options')!.click())
  const deletePage = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === '删除页面')!
  await act(async () => deletePage.click())
  expect(editor.state.doc.pages.map(page => page.id)).toEqual([doc.pages[0].id])
  expect(editor.state.page).toBe(doc.pages[0].id)
  editor.dispose()
})

test('Sketch has a compact geometry block and both inspectors edit the same selection', async () => {
  const doc = blank('工作台'), board = node('frame', 40, 20, 320, 180)
  doc.nodes[board.id] = board; doc.pages[0].children.push(board.id)
  const editor = new Editor(doc), host = document.createElement('div')
  document.body.append(host); root = createRoot(host)
  await act(async () => {
    editor.select([board.id])
    root!.render(<PendingEditContext.Provider value={editor}><Inspector editor={editor} /></PendingEditContext.Provider>)
  })
  const field = (label: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  expect(field('W').closest('.layout-panel')).not.toBeNull()
  expect(field('X').closest('.geometry-position-section')).not.toBeNull()
  await act(async () => interfacePreference.set({ uiMode:'sketch' }))
  expect(field('旋转 °').closest('.geometry-position')).not.toBeNull()
  expect(field('W').closest('.geometry-position-section')).not.toBeNull()
  expect(document.querySelector('.sketch-inspector-alignment')).not.toBeNull()
  await act(async () => field('锁定宽高比').click())
  expect(editor.state.doc.nodes[board.id].constrainProportions).toBe(true)
  await act(async () => editor.undo())
  expect(field('锁定宽高比').checked).toBe(false)
  editor.dispose()
})

test('a collapsed native-style tree reveals selected ancestors and remembers disclosure per layout', async () => {
  const doc = blank('工作台'), frame = node('frame', 0, 0, 320, 180), group = node('group', 0, 0, 80, 40)
  const child = node('rectangle', 0, 0, 32, 32)
  doc.nodes = { [frame.id]: frame, [group.id]: group, [child.id]: child }
  doc.pages[0].children = [frame.id]; frame.children = [group.id]; group.children = [child.id]
  const editor = new Editor(doc), host = document.createElement('div')
  document.body.append(host); root = createRoot(host)
  const row = (id: string) => document.querySelector(`[data-layer-id="${id}"]`)
  await act(async () => root!.render(<Layers editor={editor} />))
  expect(row(frame.id)?.getAttribute('aria-expanded')).toBe('false')
  expect(row(group.id)).toBeNull()
  await act(async () => editor.select([child.id]))
  expect(row(child.id)?.getAttribute('aria-selected')).toBe('true')
  await act(async () => editor.select([frame.id]))
  await act(async () => interfacePreference.set({ uiMode:'sketch' }))
  expect(row(group.id)?.getAttribute('aria-expanded')).toBe('false')
  expect(host.firstElementChild?.firstElementChild?.classList.contains('layer-search')).toBe(true)
  await act(async () => interfacePreference.set({ uiMode:'figma' }))
  expect(row(group.id)?.getAttribute('aria-expanded')).toBe('true')
  editor.dispose()
})

test('Sketch layer styles can be created, applied, updated and detached without changing the resolved paint', async () => {
  const doc = blank('样式'), first = node('rectangle', 0, 0, 120, 60), second = node('rectangle', 140, 0, 120, 60)
  first.fills[0].color = '#cc3311'
  doc.nodes = { [first.id]: first, [second.id]: second }; doc.pages[0].children = [first.id, second.id]
  const editor = new Editor(doc), host = document.createElement('div')
  document.body.append(host); root = createRoot(host)
  await act(async () => {
    interfacePreference.set({ uiMode:'sketch' })
    editor.select([first.id])
    root!.render(<PendingEditContext.Provider value={editor}><Inspector editor={editor} /></PendingEditContext.Provider>)
  })
  const action = (name: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!
  await act(async () => action('创建图层样式').click())
  const title = host.querySelector<HTMLInputElement>('input[aria-label="图层样式名称"]')!
  await act(async () => {
    title.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(title, '工作区样式')
    title.dispatchEvent(new Event('input', { bubbles:true }))
  })
  const submit = host.querySelector<HTMLButtonElement>('.sketch-layer-style button[type="submit"]')!
  expect(submit.disabled).toBe(false)
  await act(async () => submit.click())
  expect(editor.state.doc.nodes[first.id].styleRefs, editor.state.message).toBeDefined()
  const id = editor.state.doc.nodes[first.id].styleRefs!.fills
  expect(editor.state.doc.designSystem!.styles[id].name).toBe('工作区样式')
  await act(async () => editor.select([second.id]))
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="图层样式"]')!
  await act(async () => { select.value = id; select.dispatchEvent(new Event('change', { bubbles:true })) })
  expect(editor.state.doc.nodes[second.id].styleRefs?.fills).toBe(id)
  expect(editor.state.doc.nodes[second.id].fills[0].color).toBe('#cc3311')
  await act(async () => action('解除图层样式').click())
  expect(editor.state.doc.nodes[second.id].styleRefs?.fills).toBeUndefined()
  expect(editor.state.doc.nodes[second.id].fills[0].color).toBe('#cc3311')
  await act(async () => {
    const edited = editor.change('修改填充', draft => { draft.nodes[second.id].fills[0].color = '#2980dd' })
    expect(edited.status, editor.state.message).toBe('committed')
  })
  expect(editor.state.doc.nodes[second.id].fills[0].color).toBe('#2980dd')
  await act(async () => action('更新图层样式').click())
  const target = host.querySelector<HTMLSelectElement>('select[aria-label="用所选图层更新样式"]')!
  await act(async () => { target.value = id; target.dispatchEvent(new Event('change', { bubbles:true })) })
  expect((editor.state.doc.designSystem!.styles[id].value as typeof first.fills)[0].color, editor.state.message).toBe('#2980dd')
  expect(editor.state.doc.designSystem!.styles[id].value).toEqual(editor.state.doc.nodes[second.id].fills)
  expect(editor.state.doc.nodes[second.id].styleRefs?.fills).toBeUndefined()
  expect(editor.state.doc.nodes[first.id].styleRefs?.fills).toBe(id)
  await act(async () => editor.undo())
  expect((editor.state.doc.designSystem!.styles[id].value as typeof first.fills)[0].color).toBe('#cc3311')
  expect(editor.state.doc.nodes[second.id].fills[0].color).toBe('#2980dd')
  editor.dispose()
})

test('opaque srgb page color and memory errors are display strings, not raw engine text', () => {
  expect(displayColorHex('color(srgb 0.949019610 0.949019610 0.949019610)')).toBe('#F2F2F2')
  expect(canvasStatusLabel('The document exceeds the available WASM memory allowance. Close other documents or use a machine with more memory.')).toBe('内存不足，当前画面已保留')
})
