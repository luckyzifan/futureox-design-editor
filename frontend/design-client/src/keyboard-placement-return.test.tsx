// @ts-expect-error jsdom runtime dependency
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { screenToWorld } from './canvas-camera'
import { Canvas } from './Canvas'
import { Editor } from './engine'
import { apply, worldMatrix } from './geometry'
import { interfacePreference } from './interface-preference'
import { blank, node } from './model'
import { shortcutPreference } from './shortcut-preference'

const editors: Editor[] = []
let dom: JSDOM | undefined
let root: Root | undefined

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  editors.splice(0).forEach(editor => editor.dispose())
  dom?.window.close()
  dom = undefined
  vi.unstubAllGlobals()
  interfacePreference.reset()
  shortcutPreference.set('figma-like')
})

async function mount(editor: Editor) {
  if (root) await act(async () => root!.unmount())
  root = undefined
  dom?.window.close()
  dom = new JSDOM('<div id="root"></div>', { url: 'https://design.invalid/' })
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'localStorage'])
    vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} })
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('Worker', class {
    onmessage: ((value: MessageEvent) => void) | null = null
    constructor(_url: string | URL) {}
    postMessage() {}
    terminate() {}
    addEventListener() {}
    removeEventListener() {}
  })
  if (!dom.window.matchMedia) dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false } }) as unknown as typeof dom.window.matchMedia
  interfacePreference.reset()
  shortcutPreference.set('figma-like')
  root = createRoot(document.getElementById('root')!)
  await act(async () => { root!.render(<Canvas editor={editor} />) })
  const host = document.getElementById('design-canvas-view')
  expect(host).not.toBeNull()
  host!.focus()
  return host!
}

function pressEnter(host: HTMLElement, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init })
  host.dispatchEvent(event)
  return event
}

/** jsdom reports no layout size, so the canvas keeps its 1000×800 fallback.
 * The default camera is { x: 30, y: 35, zoom: 1 }. */
function viewportCenter(editor: Editor) {
  return screenToWorld(editor.state.view, { x: 500, y: 400 })
}

async function place(editor: Editor, tool: Editor['state']['tool']) {
  const host = await mount(editor)
  await act(async () => { editor.set({ tool, selection: [] }) })
  await act(async () => { pressEnter(host) })
  return host
}

test('Figma layout Return places a frame at the viewport center and one undo removes it', async () => {
  const editor = new Editor(blank('空白'))
  editors.push(editor)
  const before = editor.state.doc
  const host = await mount(editor)
  await act(async () => { editor.set({ tool: 'frame', selection: [] }) })
  expect(editor.state.tool).toBe('frame')
  expect(editor.state.selection).toEqual([])
  const target = host.querySelector<HTMLElement>('[data-testid="keyboard-placement-target"]')!
  expect(target).not.toBeNull()
  const { zoom, x, y } = editor.effectiveView()
  const screen = [parseFloat(target.style.left), parseFloat(target.style.top)]
  await act(async () => { pressEnter(host) })
  const page = editor.state.doc.pages[0]
  expect(page.children).toHaveLength(1)
  const created = editor.state.doc.nodes[page.children[0]]
  const center = viewportCenter(editor)
  expect(created.kind).toBe('frame')
  expect(created.name).toBe('画板')
  expect(created.width).toBe(100)
  expect(created.height).toBe(100)
  expect(created.transform[4] + created.width / 2).toBeCloseTo(center.x, 5)
  expect(created.transform[5] + created.height / 2).toBeCloseTo(center.y, 5)
  expect((created.transform[4] + created.width / 2) * zoom + x).toBeCloseTo(screen[0], 5)
  expect((created.transform[5] + created.height / 2) * zoom + y).toBeCloseTo(screen[1], 5)
  expect(editor.state.selection).toEqual([created.id])
  expect(editor.state.tool).toBe('frame')
  expect(editor.canUndo).toBe(true)
  expect(editor.state.doc).not.toBe(before)
  await act(async () => { editor.undo() })
  expect(editor.state.doc.pages[0].children).toEqual([])
  expect(editor.state.doc.nodes[created.id]).toBeUndefined()
  expect(editor.canUndo).toBe(false)
})

for (const tool of ['rectangle', 'ellipse', 'polygon', 'star', 'section'] as const) {
  test(`Figma layout Return places a ${tool} and one undo removes it`, async () => {
    const editor = new Editor(blank(tool))
    editors.push(editor)
    await place(editor, tool)
    const created = editor.state.doc.nodes[editor.state.doc.pages[0].children[0]]
    const center = viewportCenter(editor)
    expect(created.kind).toBe(tool)
    expect(created.width).toBe(100)
    expect(created.height).toBe(100)
    expect(created.transform[4] + created.width / 2).toBeCloseTo(center.x, 5)
    expect(created.transform[5] + created.height / 2).toBeCloseTo(center.y, 5)
    expect(editor.state.selection).toEqual([created.id])
    expect(editor.state.tool).toBe(tool)
    await act(async () => { editor.undo() })
    expect(editor.state.doc.pages[0].children).toEqual([])
    expect(editor.canUndo).toBe(false)
  })
}

test('Figma layout Return places text, returns to the move tool, and one undo removes it', async () => {
  const editor = new Editor(blank('文字'))
  editors.push(editor)
  await place(editor, 'text')
  const created = editor.state.doc.nodes[editor.state.doc.pages[0].children[0]]
  const center = viewportCenter(editor)
  expect(created.kind).toBe('text')
  expect(created.width).toBe(100)
  expect(created.height).toBe(100)
  expect(created.transform[4] + created.width / 2).toBeCloseTo(center.x, 5)
  expect(created.transform[5] + created.height / 2).toBeCloseTo(center.y, 5)
  expect(editor.state.selection).toEqual([created.id])
  expect(editor.state.tool).toBe('select')
  await act(async () => { editor.undo() })
  expect(editor.state.doc.pages[0].children).toEqual([])
  expect(editor.state.doc.nodes[created.id]).toBeUndefined()
  expect(editor.canUndo).toBe(false)
})

test('line and pen Return do not insert an object', async () => {
  for (const tool of ['line', 'pen'] as const) {
    const editor = new Editor(blank(tool))
    editors.push(editor)
    const host = await mount(editor)
    await act(async () => { editor.set({ tool, selection: [] }) })
    const version = editor.state.version
    expect(host.querySelector('[data-testid="keyboard-placement-target"]')).toBeNull()
    await act(async () => { pressEnter(host) })
    expect(editor.state.doc.pages[0].children).toEqual([])
    expect(editor.canUndo).toBe(false)
    expect(editor.state.version).toBe(version)
    expect(editor.state.tool).toBe(tool)
  }
})

test('Return does not place outside the canvas, in Sketch layout, or with a modifier', async () => {
  const editor = new Editor(blank('边界'))
  editors.push(editor)
  const host = await mount(editor)
  await act(async () => { editor.set({ tool: 'rectangle', selection: [] }) })
  const button = document.createElement('button')
  document.body.appendChild(button)
  button.focus()
  await act(async () => { button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
  expect(editor.state.doc.pages[0].children).toEqual([])
  host.focus()
  await act(async () => { interfacePreference.set({ uiMode: 'sketch' }) })
  await act(async () => { pressEnter(host) })
  expect(editor.state.doc.pages[0].children).toEqual([])
  await act(async () => { interfacePreference.set({ uiMode: 'figma' }) })
  await act(async () => { pressEnter(host, { metaKey: true }) })
  await act(async () => { pressEnter(host, { altKey: true }) })
  await act(async () => { pressEnter(host, { repeat: true }) })
  expect(editor.state.doc.pages[0].children).toEqual([])
  expect(editor.canUndo).toBe(false)
  await act(async () => { pressEnter(host) })
  expect(editor.state.doc.pages[0].children).toHaveLength(1)
  await act(async () => { pressEnter(host, { repeat: true }) })
  expect(editor.state.doc.pages[0].children).toHaveLength(1)
})

test('select-tool Return still enters children and Shift+Return still selects the parent', async () => {
  const frame = node('frame', 0, 0, 200, 120)
  const child = node('rectangle', 10, 10, 40, 30)
  frame.children = [child.id]
  const doc = blank('层级')
  doc.nodes[frame.id] = frame
  doc.nodes[child.id] = child
  doc.pages[0].children = [frame.id]
  const editor = new Editor(doc)
  editors.push(editor)
  const host = await mount(editor)
  await act(async () => { editor.select([frame.id]); editor.set({ tool: 'select' }) })
  const version = editor.state.version
  await act(async () => { pressEnter(host) })
  expect(editor.state.selection).toEqual([child.id])
  expect(editor.state.doc.pages[0].children).toEqual([frame.id])
  expect(frame.children).toEqual([child.id])
  expect(editor.canUndo).toBe(false)
  expect(editor.state.version).toBe(version)
  await act(async () => { editor.set({ tool: 'frame' }) })
  await act(async () => { pressEnter(host, { shiftKey: true }) })
  expect(editor.state.selection).toEqual([frame.id])
  expect(editor.state.doc.pages[0].children).toEqual([frame.id])
  expect(editor.canUndo).toBe(false)
})

test('an armed frame tool places instead of entering the selected frame', async () => {
  const frame = node('frame', 0, 0, 200, 120)
  const child = node('rectangle', 10, 10, 40, 30)
  frame.children = [child.id]
  const doc = blank('工具优先')
  doc.nodes[frame.id] = frame
  doc.nodes[child.id] = child
  doc.pages[0].children = [frame.id]
  const editor = new Editor(doc)
  editors.push(editor)
  const host = await mount(editor)
  await act(async () => { editor.select([frame.id]); editor.set({ tool: 'frame' }) })
  await act(async () => { pressEnter(host) })
  expect(editor.state.selection).not.toEqual([child.id])
  expect(editor.state.doc.pages[0].children).toHaveLength(2)
  const createdId = editor.state.selection[0]
  expect(editor.state.doc.nodes[createdId].kind).toBe('frame')
  expect(createdId).not.toBe(frame.id)
  expect(editor.state.doc.nodes[frame.id].children).toEqual([child.id])
  await act(async () => { editor.undo() })
  expect(editor.state.doc.pages[0].children).toEqual([frame.id])
  expect(editor.state.doc.nodes[createdId]).toBeUndefined()
})

test('Return parents the new rectangle into the frame under the viewport center', async () => {
  const frame = node('frame', 100, 80, 4000, 4000)
  const doc = blank('落入画板')
  doc.nodes[frame.id] = frame
  doc.pages[0].children = [frame.id]
  const editor = new Editor(doc)
  editors.push(editor)
  const host = await mount(editor)
  await act(async () => { editor.set({ tool: 'rectangle', selection: [] }) })
  await act(async () => { pressEnter(host) })
  expect(editor.state.doc.pages[0].children).toEqual([frame.id])
  const live = editor.state.doc.nodes[frame.id]
  expect(live.children).toHaveLength(1)
  const created = editor.state.doc.nodes[live.children[0]]
  const center = viewportCenter(editor)
  const world = apply(worldMatrix(editor.state.doc, created.id), { x: created.width / 2, y: created.height / 2 })
  expect(created.kind).toBe('rectangle')
  expect(world.x).toBeCloseTo(center.x, 5)
  expect(world.y).toBeCloseTo(center.y, 5)
  await act(async () => { editor.undo() })
  expect(editor.state.doc.nodes[frame.id].children).toEqual([])
  expect(editor.state.doc.pages[0].children).toEqual([frame.id])
  expect(editor.canUndo).toBe(false)
})
