import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { CameraState, CAMERA_STATE_KEY, savedCamera } from './camera-state'
import { Editor } from './engine'
import { blank } from './model'
import { interfacePreference } from './interface-preference'
let values: Map<string, string>, writes: ReturnType<typeof vi.fn>, frames: Map<number, FrameRequestCallback>
beforeEach(() => {
  vi.useFakeTimers()
  values = new Map(); writes = vi.fn((key: string, value: string) => values.set(key, value)); frames = new Map()
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => values.get(key), setItem: writes }, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  interfacePreference.set({ rememberViewport: false })
  writes.mockClear()
  let sequence = 0
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.set(++sequence, fn); return sequence })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
test('validates saved numbers and clamps zoom without truncating position precision', () => {
  const view = { x: -123456.789012345, y: 0.000000019, zoom: 32 }
  expect(savedCamera(view)).toEqual(view)
  for (const value of [null, {}, { ...view, zoom: 0 }, { ...view, zoom: Infinity }, { ...view, x: NaN }, { ...view, y: '0' }]) expect(savedCamera(value)).toBeUndefined()
  expect(savedCamera({ ...view, zoom: 100 })?.zoom).toBe(32)
  expect(savedCamera({ ...view, zoom: 0.0001 })?.zoom).toBe(0.025)
})
test('isolates document/page hints, rejects deleted pages and bounds entries and writes', () => {
  const state = new CameraState()
  for (let i = 0; i < 100; i++) state.remember('doc', 'p' + i, { x: i, y: 0, zoom: 32 })
  expect(writes).not.toHaveBeenCalled()
  vi.advanceTimersByTime(400)
  expect(writes).toHaveBeenCalledTimes(1)
  expect(JSON.parse(values.get(CAMERA_STATE_KEY)!).entries).toHaveLength(64)
  expect(state.recall('other', ['p99'])).toBeUndefined()
  expect(state.recall('doc', ['deleted'])).toBeUndefined()
  expect(state.recall('doc', ['p98', 'p99'])?.pageId).toBe('p99')
  expect(state.recall('doc', ['p98', 'p99'], 'p98')?.view.x).toBe(98)
})
test('damaged and unavailable storage keep navigation usable', () => {
  values.set(CAMERA_STATE_KEY, '{bad')
  expect(new CameraState().recall('doc', ['p'])).toBeUndefined()
  const state = new CameraState(() => { throw Error('denied') })
  state.remember('doc', 'p', { x: 1, y: 2, zoom: 32 }); state.flush()
  expect(state.recall('doc', ['p'])?.view.zoom).toBe(32)
})
test('page switch saves latest pending camera, cancels queued old view, and restores each page', () => {
  const doc = blank(), second = blank().pages[0]; doc.pages.push(second)
  const editor = new Editor(doc), first = editor.state.page, original = JSON.stringify(editor.state.doc)
  const view = { x: -9100.123456789, y: 87, zoom: 32 }
  editor.setViewCoalesced(view)
  editor.set({ page: second.id })
  expect(frames.size).toBe(0)
  expect(editor.state.view.zoom).toBe(1)
  editor.set({ view: { x: 3, y: 4, zoom: 2 } })
  editor.set({ page: first })
  expect(editor.state.view).toEqual(view)
  expect(JSON.stringify(editor.state.doc)).toBe(original)
  expect(editor.canUndo).toBe(false)
  editor.dispose()
})
test('opted-in close/reopen restores 3200% last page without screenshot and isolates other documents', () => {
  interfacePreference.set({ rememberViewport: true })
  const doc = blank(), second = blank().pages[0]; doc.pages.push(second)
  const editor = new Editor(doc)
  editor.set({ page: second.id })
  const view = { x: -50000.123456789, y: -9999.987654321, zoom: 32 }
  editor.setViewCoalesced(view)
  editor.dispose()
  expect(frames.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  const reopened = new Editor(blank())
  expect(reopened.load(doc)).toBe(true)
  expect(reopened.state.page).toBe(second.id)
  expect(reopened.state.view).toEqual(view)
  expect(reopened.preservedViewSession).toBe(reopened.sessionGeneration)
  reopened.setViewCoalesced({ x: 2, y: 3, zoom: 4 })
  const other = blank(); reopened.load(other)
  expect(frames.size).toBe(0)
  expect(reopened.state.view.zoom).toBe(1)
  reopened.load(doc)
  expect(reopened.state.view).toEqual({ x: 2, y: 3, zoom: 4 })
  reopened.dispose()
})
test('pagehide flushes the effective queued view before animation-frame delivery', () => {
  interfacePreference.set({ rememberViewport: true })
  const doc = blank(), editor = new Editor(doc)
  const view = { x: -8888.1234567, y: -2, zoom: 32 }
  editor.setViewCoalesced(view)
  const listener = vi.mocked(window.addEventListener).mock.calls.find(call => call[0] === 'pagehide')![1] as () => void
  listener()
  expect(new CameraState().recall(doc.id, [editor.state.page])?.view).toEqual(view)
  editor.dispose()
  expect(window.removeEventListener).toHaveBeenCalledWith('pagehide', listener)
  expect(vi.getTimerCount()).toBe(0)
})
test('deleted saved page falls back to a surviving page and default view without changing document bytes', () => {
  const doc = blank(), removed = blank().pages[0]; doc.pages.push(removed)
  const state = new CameraState(); state.remember(doc.id, removed.id, { x: 1, y: 2, zoom: 32 }); state.flush()
  doc.pages.pop()
  const editor = new Editor(blank()), original = JSON.stringify(doc)
  editor.load(doc)
  expect(editor.state.page).toBe(doc.pages[0].id)
  expect(editor.state.view).toEqual({ x: 40, y: 40, zoom: 1 })
  expect(editor.restoredCamera).toBe(false)
  expect(JSON.stringify(doc)).toBe(original)
  editor.dispose()
})
test('obsolete document page camera cannot overwrite an explicit current view', () => {
  const doc = blank(), second = blank().pages[0]; doc.pages.push(second)
  const editor = new Editor(doc)
  editor.setViewCoalesced({ x: 1, y: 2, zoom: 32 })
  const view = { x: 3, y: 4, zoom: 0.5 }
  editor.set({ page: second.id, view })
  expect(frames.size).toBe(0)
  expect(editor.state.view).toEqual(view)
  editor.dispose()
})

test('default reopen fits instead of restoring persisted 3200% until the user opts in', () => {
  const doc = blank(), state = new CameraState()
  state.remember(doc.id, doc.pages[0].id, { x: -9000, y: -8000, zoom: 32 }); state.flush()
  const editor = new Editor(blank())
  editor.load(doc)
  expect(editor.restoredCamera).toBe(false)
  expect(editor.preservedViewSession).toBe(-1)
  expect(editor.state.view.zoom).toBe(1)
  editor.dispose()
})

test('default navigation retains page views in memory without persisting camera hints', () => {
  const editor = new Editor(blank())
  editor.set({ view: { x: 1, y: 2, zoom: 32 } })
  expect(vi.getTimerCount()).toBe(0)
  editor.dispose()
  expect(values.has(CAMERA_STATE_KEY)).toBe(false)
})

test('partial window adapters do not install an unremovable lifecycle listener', () => {
  const addEventListener = vi.fn()
  vi.stubGlobal('window', { addEventListener })
  const editor = new Editor(blank())
  expect(addEventListener).not.toHaveBeenCalled()
  expect(() => editor.dispose()).not.toThrow()
  expect(vi.getTimerCount()).toBe(0)
})
test('lifecycle cleanup uses the registered host even if the global window changes', () => {
  const host = window, editor = new Editor(blank())
  const listener = vi.mocked(host.addEventListener).mock.calls.find(call => call[0] === 'pagehide')![1]
  vi.stubGlobal('window', {})
  editor.dispose()
  expect(host.removeEventListener).toHaveBeenCalledWith('pagehide', listener)
})
