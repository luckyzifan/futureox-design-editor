// @ts-expect-error jsdom runtime dependency
import { JSDOM } from 'jsdom'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { Canvas } from './Canvas'
import { Editor } from './engine'
import { decodeFig } from './import-fig'
import { Inspector } from './Inspector'
import { interfacePreference } from './interface-preference'
import { Layers } from './Layers'
import { blank, node, type DesignNode } from './model'
import { PendingEditContext } from './pending-edit-context'

const DASHBOARD_FIG = fileURLToPath(new URL('../../../testing/fixtures/user-regression-20261109/01有料素材 (Copy).fig', import.meta.url))
const DASHBOARD_FIG_SHA256 = '701877664bf271305c8bc103c4036a228d7bd8816f1d98f18cdc332a75c36c46'
const DASHBOARD_CHILD_ORDER = ['1440x12xGrid', 'Header', 'Menu Panel', 'Cards', 'Monthly Chart', 'Bar Chart', 'Posting Tasks', 'Top Performance', 'Simple Chart']
const figGuid = (value: { sessionID?: number; localID?: number } | string | undefined) =>
  typeof value === 'string' ? value : value ? `${value.sessionID}:${value.localID}` : ''

const bootstrap = await vi.hoisted(async () => {
  // @ts-expect-error jsdom runtime dependency
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<html><body></body></html>')
  for (const key of ['window', 'document', 'navigator']) vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key])
  return dom
})
bootstrap.window.close()

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
})

function dashboardEditor() {
  const bytes = readFileSync(DASHBOARD_FIG)
  expect(bytes.subarray(0, 8).toString()).not.toBe('version ')
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(DASHBOARD_FIG_SHA256)
  const { data } = decodeFig(bytes)
  const records = new Map<string, Record<string, any>>()
  for (const change of data.nodeChanges || []) {
    const id = figGuid(change.guid)
    if (change.phase === 'REMOVED') records.delete(id)
    else records.set(id, { ...records.get(id), ...change })
  }
  const board = [...records.values()].find(record => record.name === '01_Dashboard' && record.type === 'FRAME' && figGuid(record.guid) === '0:7861')
  if (!board) throw new Error('01_Dashboard 0:7861 was not in the fixture')
  const stored = [...records.values()].filter(record => figGuid(record.parentIndex?.guid) === '0:7861')
  stored.sort((left, right) => {
    const a = String(left.parentIndex?.position || ''), b = String(right.parentIndex?.position || '')
    return a < b ? -1 : a > b ? 1 : 0
  })
  const document = blank('01有料素材 (Copy)'), frame = node('frame')
  frame.name = '01_Dashboard'
  const children = stored.map(record => {
    const child = node('frame')
    child.name = String(record.name)
    child.visible = record.visible !== false
    child.locked = !!record.locked
    return child
  })
  frame.children = children.map(child => child.id)
  document.nodes = Object.fromEntries([frame, ...children].map(child => [child.id, child]))
  document.pages[0].children = [frame.id]
  const editor = new Editor(document)
  editors.push(editor)
  return { editor, frame, children }
}

async function mount(editor: Editor) {
  dom = new JSDOM('<div id="root"></div>', { url: 'https://design.invalid/' })
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'localStorage'])
    vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} })
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  interfacePreference.reset()
  root = createRoot(document.getElementById('root')!)
  await act(async () => {
    root!.render(<PendingEditContext.Provider value={editor}>
      <Layers editor={editor} showPages={false} />
      <Inspector editor={editor} />
    </PendingEditContext.Provider>)
  })
}

function row(name: string) {
  return [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')].find(item => item.getAttribute('aria-label') === name)
}

test('left tree and right rail show the hidden grid in the Return selection', async () => {
  const { editor, frame, children } = dashboardEditor()
  const original = editor.state.doc, version = editor.state.version
  const grid = children.find(child => child.name === '1440x12xGrid') as DesignNode
  editor.select([frame.id])
  expect(editor.selectChildren()).toBe(true)
  await mount(editor)
  const labels = [...document.querySelectorAll('[role="treeitem"]')].map(item => item.getAttribute('aria-label'))
  expect(labels.slice(1)).toEqual(DASHBOARD_CHILD_ORDER)
  for (const name of DASHBOARD_CHILD_ORDER) expect(row(name)?.getAttribute('aria-selected')).toBe('true')
  expect(row('01_Dashboard')?.getAttribute('aria-selected')).toBe('false')
  expect(row('1440x12xGrid')?.className).toContain('hidden-layer')
  expect(row('1440x12xGrid')?.className).toContain('selected')
  const rail = document.querySelector('[aria-label="多选属性"]')
  expect(rail).not.toBeNull()
  expect(rail?.textContent).toContain('9 个图层')
  expect(editor.state.doc).toBe(original)
  expect(editor.state.version).toBe(version)
  expect(editor.canUndo).toBe(false)
  expect(editor.state.doc.nodes[grid.id].visible).toBe(false)
  await act(async () => { expect(editor.selectParent()).toBe(true) })
  expect(editor.state.selection).toEqual([frame.id])
  expect(row('01_Dashboard')?.getAttribute('aria-selected')).toBe('true')
  expect(row('1440x12xGrid')?.getAttribute('aria-selected')).toBe('false')
  expect(document.querySelector('[aria-label="多选属性"]')).toBeNull()
  expect(editor.state.doc).toBe(original)
  expect(editor.state.doc.nodes[grid.id].visible).toBe(false)
  expect(editor.canUndo).toBe(false)
})

// The canvas key listener is the real Canvas effect. The render worker is
// replaced so this jsdom process can mount the view; it does not paint.
test('canvas Return and Shift+Return select the hidden grid and return to the artboard', async () => {
  const { editor, frame } = dashboardEditor()
  const original = editor.state.doc, version = editor.state.version
  editor.select([frame.id])
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
  root = createRoot(document.getElementById('root')!)
  await act(async () => { root!.render(<Canvas editor={editor} />) })
  const host = document.getElementById('design-canvas-view')
  expect(host).not.toBeNull()
  host!.focus()
  await act(async () => {
    host!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  expect(editor.state.selection.map(id => editor.state.doc.nodes[id].name)).toEqual(DASHBOARD_CHILD_ORDER)
  expect(editor.state.doc.nodes[editor.state.selection[0]].visible).toBe(false)
  expect(editor.state.doc).toBe(original)
  expect(editor.state.version).toBe(version)
  expect(editor.canUndo).toBe(false)
  await act(async () => {
    host!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }))
  })
  expect(editor.state.selection).toEqual([frame.id])
  expect(editor.state.doc).toBe(original)
  expect(editor.canUndo).toBe(false)
})
