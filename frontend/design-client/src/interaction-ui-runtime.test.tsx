// Real React/jsdom, Editor, and the current WASM: no browser/GPU/pixel claim.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act, useEffect, useState, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { appendFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { blank, node } from './model'
import { DesktopSession, type DesktopStatus } from './desktop-session'
import type { DesktopBridge, DesktopFile, DesktopResult } from './desktop'
import { Inspector } from './Inspector'
import { Layers } from './Layers'
import { PendingEditContext } from './pending-edit-context'
import * as units from './property-units'
import * as geometry from './geometry'

// React chooses its DOM input/composition event implementation at import time.
// Initialize a real DOM before importing it, while retaining the Node test
// environment used by the shared WASM setup's file URLs.
const bootstrapDom = await vi.hoisted(async () => {
  // @ts-expect-error jsdom is a test-only runtime dependency.
  const { JSDOM } = await import('jsdom')
  const initial = new JSDOM('<!doctype html><html><body></body></html>')
  for (const name of ['window', 'document', 'navigator'])
    vi.stubGlobal(name, name === 'window' ? initial.window : initial.window[name])
  return initial
})
bootstrapDom.window.close()

let dom: any, mount: HTMLDivElement, root: Root
let consoleErrors: unknown[][]
const disposals: (() => void)[] = []
beforeEach(() => {
  consoleErrors = []
  const originalError = console.error.bind(console)
  vi.spyOn(console, 'error').mockImplementation((...args) => { consoleErrors.push(args); originalError(...args) })
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Node', 'Event', 'KeyboardEvent', 'localStorage'])
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  mount = document.createElement('div'); document.body.append(mount); root = createRoot(mount)
})
afterEach(async () => {
  await act(async () => root.unmount())
  disposals.splice(0).forEach(dispose => dispose())
  dom.window.close(); vi.unstubAllGlobals(); vi.restoreAllMocks()
  expect(consoleErrors).toEqual([])
})

function fixture(size = 256) {
  const doc = blank('Interaction UI runtime'), text = node('text', 10, 20, 160, 32)
  text.text = 'Live text'; text.name = 'Selected text'
  doc.nodes[text.id] = text
  for (let i = 1; i < size; i++) {
    const shape = node('rectangle', i * 8, 100, 6, 6)
    doc.nodes[shape.id] = shape
  }
  // Keep the selected text in the virtualized visible range.
  doc.pages[0].children = [...Object.keys(doc.nodes).filter(id => id !== text.id), text.id]
  const editor = new Editor(doc); editor.select([text.id]); disposals.push(() => editor.dispose())
  const ok = { status: 'ok' } as const, cancelled = { status: 'cancelled' } as const
  const bridge = {
    version: 1, renderPolicy: Object.freeze({ cpuOnly: true }),
    readRecovery: vi.fn(async () => cancelled), clearRecovery: vi.fn(async () => ok),
    writeRecovery: vi.fn(async () => ok), setDirty: vi.fn(async (_dirty: boolean) => {}),
    saveDocument: vi.fn<DesktopBridge['saveDocument']>(async () => ({ ...ok, handle: 'runtime-file', displayName: 'runtime.fd' })),
  } as unknown as DesktopBridge
  const statuses: DesktopStatus[] = []
  let statusSink: ((value: DesktopStatus) => void) | undefined, shellRenders = 0
  const session = new DesktopSession(bridge, editor, async () => 'cancel', status => { statuses.push(status); statusSink?.(status) })
  disposals.push(() => session.dispose())
  // App's two state sources, with its actual Layers/Inspector descendants.
  // Canvas and native IPC are deliberately outside this CPU/subscription test.
  function PanelShell() {
    const state = useSyncExternalStore(editor.subscribe, editor.panelSnapshot)
    const [status, setStatus] = useState(session.status)
    useEffect(() => { statusSink = setStatus; return () => { statusSink = undefined } }, [])
    shellRenders++
    return <PendingEditContext.Provider value={editor}>
      <output data-testid="status">{`${status.dirty}:${status.busy}:${status.operation}:${status.error ?? ''}`}</output>
      <output data-testid="selection">{state.selection.join(',')}</output>
      <Layers editor={editor} /><Inspector editor={editor} />
    </PendingEditContext.Provider>
  }
  return { editor, text, bridge, session, statuses, PanelShell, renders: () => shellRenders }
}

function report(name: string, value: Record<string, unknown>) {
  const result = { name, runtime: 'React/jsdom + real Editor/WASM; no Canvas or native browser', ...value }
  console.info('INTERACTION_UI_METRIC', JSON.stringify(result))
  if (process.env.INTERACTION_UI_METRICS) appendFileSync(process.env.INTERACTION_UI_METRICS, JSON.stringify(result) + '\n')
}

test('camera-only writes do not rerender text properties or rescan document parents', async () => {
  const f = fixture(), properties = vi.spyOn(units, 'propertyUnits'), parents = vi.spyOn(geometry, 'allParents')
  await act(async () => root.render(<f.PanelShell />))
  const initialHtml = mount.innerHTML, initialDocument = f.editor.state.doc, renders = f.renders()
  properties.mockClear(); parents.mockClear(); f.statuses.length = 0
  const started = performance.now()
  for (let i = 1; i <= 120; i++) act(() => f.editor.set({ view: { x: i, y: -i, zoom: 1 + i / 100 } }))
  report('camera-120', { nodes: 256, durationMs: performance.now() - started, propertyUnitCalls: properties.mock.calls.length,
    allParentsCalls: parents.mock.calls.length, shellRenders: f.renders() - renders, statusPublications: f.statuses.length })
  expect(f.editor.state.doc).toBe(initialDocument)
  expect(mount.innerHTML).toBe(initialHtml)
  expect(properties).not.toHaveBeenCalled()
  expect(parents).not.toHaveBeenCalled()
  expect(f.renders()).toBe(renders)
  expect(f.statuses).toHaveLength(0)
})

test('drag samples publish dirty once, keep Layers and Inspector frozen, and commit final geometry immediately', async () => {
  const f = fixture(), properties = vi.spyOn(units, 'propertyUnits'), parents = vi.spyOn(geometry, 'allParents')
  await f.session.start(); expect(await f.session.save()).toBe(true)
  const wallNow = performance.now.bind(performance), inputStart = wallNow(); let clock = inputStart
  const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)
  await act(async () => root.render(<f.PanelShell />))
  const base = f.editor.state.doc, before = f.editor.state.doc.nodes[f.text.id].transform
  const version = f.editor.state.version, renders = f.renders()
  properties.mockClear(); parents.mockClear(); f.statuses.length = 0
  // The preview transaction freezes Layers/Inspector. Status still publishes once.
  // Wall-clock duration uses the real function, including actual WASM/React work.
  const start = wallNow()
  f.editor.begin('Runtime move')
  for (let i = 1; i <= 36; i++) {
    clock = inputStart + i
    act(() => expect(f.editor.preview({ [f.text.id]: { transform: [1, 0, 0, 1, before[4] + i, before[5]] } })).toBe(true))
  }
  const during = { nodes: 256, samples: 36, durationMs: wallNow() - start, propertyUnitCalls: properties.mock.calls.length,
    allParentsCalls: parents.mock.calls.length, shellRenders: f.renders() - renders, statusPublications: f.statuses.length }
  act(() => f.editor.commit()); now.mockRestore()
  report('drag-36', during)
  expect(f.statuses).toHaveLength(1)
  expect(f.statuses[0].dirty).toBe(true)
  expect(during.shellRenders).toBe(1)
  expect(f.editor.state.version).toBe(version + 1)
  expect(f.editor.state.doc.nodes[f.text.id].transform[4]).toBe(before[4] + 36)
  expect(mount.querySelector('[aria-label="X"]')?.getAttribute('aria-valuenow')).toBe(String(before[4] + 36))
  act(() => f.editor.undo()); expect(f.editor.state.doc).toEqual(base)
  expect(mount.querySelector('[aria-label="X"]')?.getAttribute('aria-valuenow')).toBe(String(before[4]))
  act(() => f.editor.redo()); expect(f.editor.state.doc.nodes[f.text.id].transform[4]).toBe(before[4] + 36)
})

test('cancel and selection changes publish the correct current text and coordinates', async () => {
  const f = fixture(4)
  await act(async () => root.render(<f.PanelShell />))
  const original = f.editor.state.doc, base = original.nodes[f.text.id].transform
  f.editor.begin('Cancelled move')
  act(() => { expect(f.editor.preview({ [f.text.id]: { transform: [1, 0, 0, 1, 420, 80] } })).toBe(true) })
  act(() => f.editor.cancel())
  expect(f.editor.state.doc).toBe(original)
  expect(mount.querySelector('[aria-label="X"]')?.getAttribute('aria-valuenow')).toBe(String(base[4]))
  const rectangle = Object.values(f.editor.state.doc.nodes).find(n => n.kind === 'rectangle')!
  act(() => f.editor.select([rectangle.id])); expect(mount.querySelector('.text-style-panel')).toBeNull()
  act(() => f.editor.select([f.text.id])); expect(mount.querySelector('.text-style-panel')).not.toBeNull()
  act(() => f.editor.update([f.text.id], { text: 'Updated selection', fontSize: 28 }, 'Text update'))
  expect(mount.querySelector('[aria-label="字号"]')?.getAttribute('aria-valuenow')).toBe('28')
  expect(mount.querySelector('textarea')?.value).toBe('Updated selection')
  act(() => f.editor.undo()); expect(mount.querySelector('textarea')?.value).toBe('Live text')
})

test('preview samples keep Layers and Inspector frozen until release publishes the final sample', async () => {
  const f = fixture(4), originalX = f.editor.state.doc.nodes[f.text.id].transform[4]
  let clock = 1000
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  await act(async () => root.render(<f.PanelShell />))
  const x = () => mount.querySelector('[aria-label="X"]')?.getAttribute('aria-valuenow')
  const preview = (time: number, value: number) => {
    clock = time
    act(() => { expect(f.editor.preview({ [f.text.id]: { transform: [1, 0, 0, 1, value, 20] } })).toBe(true) })
  }
  f.editor.begin('Elapsed move')
  preview(1020, 200); expect(x()).toBe(String(originalX))
  preview(1081, 300); expect(f.editor.interactionActive).toBe(true); expect(x()).toBe(String(originalX))
  preview(1100, 400); expect(x()).toBe(String(originalX))
  act(() => f.editor.commit()); expect(f.editor.interactionActive).toBe(false); expect(x()).toBe('400')
})

test('save busy/error/cancellation and clean transitions remain observable', async () => {
  const f = fixture(4)
  await f.session.start(); expect(await f.session.save()).toBe(true)
  await act(async () => root.render(<f.PanelShell />))
  act(() => f.editor.update([f.text.id], { text: 'Save latest' }, 'Text update'))
  expect(f.session.dirty).toBe(true)
  let finish!: (value: DesktopResult<DesktopFile>) => void
  vi.mocked(f.bridge.saveDocument).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  let saving!: ReturnType<DesktopSession['save']>
  await act(async () => { saving = f.session.save(); for (let i = 0; i < 12; i++) await Promise.resolve() })
  expect(mount.querySelector('[data-testid="status"]')?.textContent).toBe('true:true:save:')
  await act(async () => { finish({ status: 'cancelled' }); expect(await saving).toBe(false) })
  expect(mount.querySelector('[data-testid="status"]')?.textContent).toBe('true:false:idle:')
  vi.mocked(f.bridge.saveDocument).mockResolvedValueOnce({ status: 'error', code: 'WRITE_FAILED', message: 'Runtime write failure' })
  await act(async () => { expect(await f.session.save()).toBe(false) })
  expect(mount.querySelector('[data-testid="status"]')?.textContent).toContain('Runtime write failure')
  await act(async () => { expect(await f.session.save()).toBe(true) })
  expect(mount.querySelector('[data-testid="status"]')?.textContent).toBe('false:false:idle:')
  expect(f.statuses.some(status => status.busy && status.operation === 'save')).toBe(true)
  expect(f.statuses.some(status => !!status.error)).toBe(true)
  expect(f.statuses.at(-1)?.dirty).toBe(false)
  expect(JSON.parse(vi.mocked(f.bridge.saveDocument).mock.calls.at(-1)![0].documentJson).nodes[f.text.id].text).toBe('Save latest')
})

test('real textarea typing and IME survive camera updates, then blur/save/undo use the latest text', async () => {
  const f = fixture(4)
  await f.session.start(); expect(await f.session.save()).toBe(true)
  await act(async () => root.render(<f.PanelShell />))
  const field = mount.querySelector<HTMLTextAreaElement>('[aria-label="文字内容"]')!
  act(() => field.focus())
  act(() => {
    field.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }))
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'Typed 草稿')
    field.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  expect(f.session.dirty).toBe(true)
  const properties = vi.spyOn(units, 'propertyUnits')
  act(() => f.editor.set({ view: { x: 200, y: -80, zoom: 2 } }))
  expect(properties).not.toHaveBeenCalled()
  expect(mount.querySelector('[aria-label="文字内容"]')).toBe(field)
  expect(field.value).toBe('Typed 草稿')
  await act(async () => { expect(await f.session.save()).toBe(false) })
  expect(f.editor.state.doc.nodes[f.text.id].text).toBe('Live text')
  act(() => {
    field.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true, data: '草稿' }))
    field.blur()
  })
  expect(f.editor.state.doc.nodes[f.text.id].text).toBe('Typed 草稿')
  await act(async () => { expect(await f.session.save()).toBe(true) })
  expect(f.session.dirty).toBe(false)
  expect(JSON.parse(vi.mocked(f.bridge.saveDocument).mock.calls.at(-1)![0].documentJson).nodes[f.text.id].text).toBe('Typed 草稿')
  act(() => f.editor.undo()); expect(field.value).toBe('Live text')
})
