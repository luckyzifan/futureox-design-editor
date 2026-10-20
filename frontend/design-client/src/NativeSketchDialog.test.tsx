// Actual React portal/focus flows; bridge responses are deterministic. This does
// not substitute for an operating-system file-dialog or native file round trip.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act, StrictMode, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { NativeSketchDialog } from './NativeSketchDialog'
import { nativeSketchCapabilities } from './native-sketch-capabilities'
import { NativeSketchDialogContent } from './NativeSketchDialogContent'
const loadContent = async () => NativeSketchDialogContent
import type { DesktopBridge, SketchSessionBridge } from './desktop'

let dom: any, root: Root, mount: HTMLElement, trigger: HTMLButtonElement
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'KeyboardEvent']) vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  mount = document.createElement('div'); document.body.append(mount); root = createRoot(mount)
  trigger = document.createElement('button'); document.body.append(trigger); trigger.focus()
})
afterEach(async () => { await act(async () => root.unmount()); dom.window.close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const owner = { kernel_id: 'sketch' as const, document_schema: 'sketch-native-v1' as const, document_id: 'native-file', session_epoch: 1 }
const inspection = { status: 'ok' as const, displayName: 'Original.sketch', owner, pageCount: 1, layerCount: 2, editable: false, renderable: false, preview: { status: 'unavailable' as const, reason: 'Unsupported native preview feature' } }
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === label)!
function Harness({ bridge, mode = 'inspect' }: { bridge: DesktopBridge; mode?: 'inspect' | 'edit' }) {
  const [open, setOpen] = useState(true)
  return open && <NativeSketchDialog load={loadContent} bridge={bridge} mode={mode} returnFocus={trigger} onClose={() => setOpen(false)} />
}
function editBridge() {
  const methods = ['open', 'rename', 'undo', 'redo', 'status', 'close', 'saveAs', 'preview', 'leafFrame', 'setLeafFrame', 'resizeLegacyContainer', 'textTargets', 'textValue', 'setTextOverride']
  return Object.fromEntries(methods.map(method => [method, vi.fn(async () => ({ status: 'cancelled' }))])) as unknown as SketchSessionBridge
}
test('Web/inspection-only/partial Electron bridges never advertise editing', () => {
  expect(nativeSketchCapabilities()).toEqual({ inspect: false, edit: false })
  expect(nativeSketchCapabilities({ inspectSketch: vi.fn() })).toEqual({ inspect: true, edit: false })
  expect(nativeSketchCapabilities({ sketchSession: { open: vi.fn() } as never })).toEqual({ inspect: false, edit: false })
  expect(nativeSketchCapabilities({ sketchSession: editBridge() })).toEqual({ inspect: false, edit: true })
})
test('explicit read-only chooser does not auto-run, deduplicates clicks, rejects writes, and restores focus on cancel', async () => {
  let finish!: (value: unknown) => void
  const inspectSketch = vi.fn(() => new Promise(resolve => { finish = resolve })), session = editBridge()
  await act(async () => root.render(<StrictMode><Harness bridge={{ inspectSketch, sketchSession: session } as unknown as DesktopBridge} /></StrictMode>))
  expect(inspectSketch).not.toHaveBeenCalled(); expect(mount.hasAttribute('inert')).toBe(true)
  await act(async () => { button('选择 Sketch 文件…').click(); button('选择 Sketch 文件…').click() })
  expect(inspectSketch).toHaveBeenCalledOnce(); expect(button('选择 Sketch 文件…').disabled).toBe(true)
  await act(async () => { finish(inspection); await Promise.resolve() })
  expect(document.body.textContent).toContain('本机只读预览'); expect(document.body.textContent).toContain('Unsupported native preview feature')
  expect(button('确认打开').disabled).toBe(true)
  for (const method of ['rename', 'saveAs', 'open'] as const) expect(session[method]).not.toHaveBeenCalled()
  const dialog = document.querySelector('[role="dialog"]')!
  for (const options of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }]) await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, ...options })))
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  await act(async () => button('取消').click()); expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(document.activeElement).toBe(trigger); expect(mount.hasAttribute('inert')).toBe(false); expect(document.body.style.overflow).toBe('')
})
test('cancelled or malformed inspection stays read-only and stale asynchronous completion cannot reopen a dismissed dialog', async () => {
  const inspectSketch = vi.fn().mockResolvedValueOnce({ ...inspection, editable: true }).mockResolvedValueOnce({ status: 'cancelled' })
  await act(async () => root.render(<Harness bridge={{ inspectSketch } as unknown as DesktopBridge} />))
  await act(async () => button('选择 Sketch 文件…').click()); expect(document.querySelector('[role="alert"]')!.textContent).toContain('能力不匹配')
  await act(async () => button('选择 Sketch 文件…').click()); expect(button('确认打开').disabled).toBe(true)
  let finish!: (value: unknown) => void; inspectSketch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await act(async () => button('选择 Sketch 文件…').click()); await act(async () => button('取消').click())
  await act(async () => finish(inspection)); expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(trigger)
})
test('full Electron edit capability reaches the existing independent session and preserves native close cancellation', async () => {
  const session = editBridge(), state = { owner, active: true, revision: 0, savedRevision: 0, saveUncertain: false, dirty: false, undoCount: 0, redoCount: 0, layers: [], layersTruncated: false, persistence: 'memory-only-unsaved' as const }
  vi.mocked(session.open).mockResolvedValue({ status: 'ok', ...state, displayName: 'Original.sketch' })
  vi.mocked(session.close).mockResolvedValueOnce({ status: 'cancelled' }).mockResolvedValueOnce({ status: 'ok' })
  await act(async () => root.render(<Harness bridge={{ sketchSession: session } as unknown as DesktopBridge} mode="edit" />))
  expect(session.open).not.toHaveBeenCalled(); expect(document.body.textContent).toContain('有限')
  await act(async () => button('选择或恢复 Sketch 原生会话…').click())
  expect(session.open).toHaveBeenCalledOnce(); expect(button('另存为新 Sketch 文件…')).toBeDefined()
  await act(async () => button('另存为新 Sketch 文件…').click()); expect(session.saveAs).toHaveBeenCalledWith({ owner, expectedRevision: 0 })
  await act(async () => button('关闭 Sketch 会话（有修改时确认放弃）').click()); expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  await act(async () => button('关闭 Sketch 会话（有修改时确认放弃）').click()); expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(trigger)
})

// The native close handshake may need the .fd confirmation before its separate
// Sketch confirmation. Suspending focus ownership must preserve the open UI.
test('native file-close confirmation can temporarily own focus without discarding the Sketch dialog', async () => {
  const bridge = { inspectSketch: vi.fn(async () => ({ status: 'cancelled' as const })) } as unknown as DesktopBridge
  const render = (suspended: boolean) => <NativeSketchDialog load={loadContent} bridge={bridge} mode="inspect" onClose={() => {}} returnFocus={trigger} suspended={suspended} />
  await act(async () => root.render(render(false))); expect(mount.hasAttribute('inert')).toBe(true)
  await act(async () => root.render(render(true))); expect(mount.hasAttribute('inert')).toBe(false)
  const confirmation = document.createElement('button'); mount.append(confirmation); confirmation.focus(); expect(document.activeElement).toBe(confirmation)
  await act(async () => root.render(render(false))); expect(mount.hasAttribute('inert')).toBe(true)
  expect(document.querySelector('[role="dialog"]')!.contains(document.activeElement)).toBe(true)
  expect(bridge.inspectSketch).not.toHaveBeenCalled()
})

test('lazy loading exposes an owned cancellable modal, rejects stale completion, and offers retry on failure', async () => {
  let finish!: (dialog: typeof NativeSketchDialogContent) => void
  const load = vi.fn(() => new Promise<typeof NativeSketchDialogContent>(resolve => { finish = resolve }))
  const bridge = { inspectSketch: vi.fn() } as unknown as DesktopBridge
  function LoadingHarness() {
    const [open, setOpen] = useState(true)
    return open && <NativeSketchDialog bridge={bridge} mode="inspect" onClose={() => setOpen(false)} returnFocus={trigger} load={load} />
  }
  await act(async () => root.render(<LoadingHarness />))
  expect(document.body.textContent).toContain('正在载入原生 Sketch'); expect(mount.hasAttribute('inert')).toBe(true)
  await act(async () => button('取消').click()); expect(document.activeElement).toBe(trigger)
  await act(async () => finish(NativeSketchDialogContent)); expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(bridge.inspectSketch).not.toHaveBeenCalled()
  const retry = vi.fn().mockRejectedValueOnce(Error('chunk unavailable')).mockResolvedValueOnce(NativeSketchDialogContent)
  await act(async () => root.render(<NativeSketchDialog bridge={bridge} mode="inspect" onClose={() => {}} returnFocus={trigger} load={retry} />))
  expect(document.querySelector('[role="alert"]')!.textContent).toContain('chunk unavailable')
  await act(async () => button('重试').click()); expect(button('选择 Sketch 文件…')).toBeDefined(); expect(retry).toHaveBeenCalledTimes(2)
})
