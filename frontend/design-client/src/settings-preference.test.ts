import { afterEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { blank } from './model'
import { bindEditorSettings, createSettingsPreference, DEFAULT_CANVAS_SETTINGS, SETTINGS_PREFERENCE_KEY } from './settings-preference'

const editors: Editor[] = [], cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(stop => stop()); editors.splice(0).forEach(editor => editor.dispose()); vi.unstubAllGlobals() })
function memory(raw: string | null = null) {
  const values = new Map<string, string>(raw === null ? [] : [[SETTINGS_PREFERENCE_KEY, raw]])
  const storage = { getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { values.set(key, value) }) }
  return { values, storage, preference: createSettingsPreference(() => storage) }
}
function editor() { const result = new Editor(blank('Settings test')); editors.push(result); return result }

test('validated saved values survive recreation and snapshots are stable without repeated storage reads', () => {
  const f = memory()
  expect(f.preference.getSnapshot()).toEqual(DEFAULT_CANVAS_SETTINGS)
  expect(f.preference.set({ grid: true, snap: false, rulers: true })).toBe(true)
  const persisted = createSettingsPreference(() => f.storage), first = persisted.getSnapshot()
  expect(first).toMatchObject({ grid: true, snap: false, rulers: true, pixelGrid: true })
  f.storage.getItem.mockClear()
  for (let i = 0; i < 500; i++) expect(persisted.getSnapshot()).toBe(first)
  expect(f.storage.getItem).not.toHaveBeenCalled()
  expect(Object.isFrozen(first)).toBe(true)
  expect([...f.values.keys()]).toEqual([SETTINGS_PREFERENCE_KEY])
})

test.each(['broken {', 'null', '[]', 'true', '42', '"snap"'])('corrupt or non-object preference %s falls back safely', raw => {
  expect(memory(raw).preference.getSnapshot()).toEqual(DEFAULT_CANVAS_SETTINGS)
})

test('partial payload validates per field, ignores unrelated values, and setter rejects invalid patches atomically', () => {
  const f = memory(JSON.stringify({ snap: false, pixelGrid: 'false', grid: 1, rulers: true, quality: 0.1 }))
  expect(f.preference.getSnapshot()).toEqual({ ...DEFAULT_CANVAS_SETTINGS, snap: false, rulers: true })
  const before = f.preference.getSnapshot(), listener = vi.fn(), stop = f.preference.subscribe(listener)
  expect(f.preference.set({ snap: true, grid: 'bad' } as never)).toBe(false)
  expect(f.preference.set({ snap: true, gpuBudget: 100 } as never)).toBe(false)
  expect(f.preference.set(null as never)).toBe(false)
  expect(f.preference.getSnapshot()).toBe(before)
  expect(f.storage.setItem).not.toHaveBeenCalled(); expect(listener).not.toHaveBeenCalled(); stop()
})

test('unavailable or full storage keeps live values, reports session-only and can recover on a later write', () => {
  const f = memory()
  f.storage.setItem.mockImplementationOnce(() => { throw new Error('quota') })
  expect(f.preference.set({ snapPixels: false })).toBe(false)
  expect(f.preference.getSnapshot().snapPixels).toBe(false)
  expect(f.preference.getPersistenceSnapshot()).toBe('session-only')
  expect(f.preference.set({ grid: true })).toBe(true)
  expect(f.preference.getPersistenceSnapshot()).toBe('available')
  expect(createSettingsPreference(() => f.storage).getSnapshot()).toMatchObject({ snapPixels: false, grid: true })
  const absent = createSettingsPreference(() => undefined)
  expect(absent.set({ rulers: true })).toBe(false)
  expect(absent.getSnapshot().rulers).toBe(true)
  const denied = createSettingsPreference(() => { throw new Error('denied') })
  expect(denied.getSnapshot()).toEqual(DEFAULT_CANVAS_SETTINGS)
  expect(denied.set({ pixelGrid: false })).toBe(false)
  expect(denied.getSnapshot().pixelGrid).toBe(false)
})

test('binding restores genuine Editor flags, leaves legacy wheel alone, and never dirties document/history', () => {
  const f = memory(JSON.stringify({ snap: false, rulers: true, pixelGrid: false }))
  const e = editor(); e.setScrollWheelZoom(true)
  const document = e.state.doc, version = e.state.version, view = e.state.view
  cleanups.push(bindEditorSettings(e, f.preference))
  expect(e.state).toMatchObject({ snap: false, rulers: true, pixelGrid: false, scrollWheelZoom: true })
  expect(e.state.doc).toBe(document); expect(e.state.version).toBe(version); expect(e.state.view).toBe(view)
  expect(e.canUndo).toBe(false); expect(e.canRedo).toBe(false)
  expect(f.storage.setItem).not.toHaveBeenCalled()
})

test('camera and unrelated editor notifications do no preference I/O or subscriber notifications', () => {
  const f = memory(), e = editor(), listener = vi.fn()
  cleanups.push(bindEditorSettings(e, f.preference), f.preference.subscribe(listener))
  f.storage.getItem.mockClear(); f.storage.setItem.mockClear()
  for (let i = 0; i < 1000; i++) e.set({ view: { x: i + 0.00001, y: -i, zoom: 1.123456789 }, message: String(i) })
  expect(f.storage.getItem).not.toHaveBeenCalled(); expect(f.storage.setItem).not.toHaveBeenCalled()
  expect(listener).not.toHaveBeenCalled()
  expect(e.state.view).toEqual({ x: 999.00001, y: -999, zoom: 1.123456789 })
})

test('view-control changes persist once, synchronize other editors, and rebind without duplicate writes', () => {
  const f = memory(), a = editor(), b = editor()
  const stopA = bindEditorSettings(a, f.preference)
  cleanups.push(bindEditorSettings(b, f.preference))
  a.set({ grid: true, snapPixels: false })
  expect(f.storage.setItem).toHaveBeenCalledTimes(1)
  expect(b.state).toMatchObject({ grid: true, snapPixels: false })
  stopA(); a.set({ grid: false })
  expect(f.storage.setItem).toHaveBeenCalledTimes(1)
  cleanups.push(bindEditorSettings(a, f.preference))
  expect(a.state.grid).toBe(true)
  expect(f.storage.setItem).toHaveBeenCalledTimes(1)
  a.set({ checkerboard: true })
  expect(f.storage.setItem).toHaveBeenCalledTimes(2)
  expect(b.state.checkerboard).toBe(true)
  f.preference.reset()
  expect(f.preference.getSnapshot()).toEqual(DEFAULT_CANVAS_SETTINGS)
  expect(a.state).toMatchObject(DEFAULT_CANVAS_SETTINGS)
  expect(b.state).toMatchObject(DEFAULT_CANVAS_SETTINGS)
})

test('storage listener filters unrelated keys, handles clear, and is removed after last subscriber', () => {
  const target = new EventTarget(), f = memory(), e = editor()
  const add = vi.spyOn(target, 'addEventListener'), remove = vi.spyOn(target, 'removeEventListener')
  vi.stubGlobal('window', target)
  const stop = bindEditorSettings(e, f.preference)
  expect(add).toHaveBeenCalledTimes(1)
  const emit = (key: string | null) => { const event = new Event('storage'); Object.defineProperties(event, { key: { value: key }, storageArea: { value: null } }); target.dispatchEvent(event) }
  f.values.set(SETTINGS_PREFERENCE_KEY, JSON.stringify({ snap: false }))
  emit('forma-scroll-wheel-zoom'); expect(e.state.snap).toBe(true)
  emit(SETTINGS_PREFERENCE_KEY); expect(e.state.snap).toBe(false)
  expect(f.storage.setItem).not.toHaveBeenCalled()
  f.values.clear(); emit(null); expect(e.state.snap).toBe(true)
  stop(); expect(remove).toHaveBeenCalledTimes(1)
  f.values.set(SETTINGS_PREFERENCE_KEY, JSON.stringify({ snap: false })); emit(SETTINGS_PREFERENCE_KEY)
  expect(e.state.snap).toBe(true)
})

test('changing the document retains local canvas preferences without persisting document data or extra writes', () => {
  const f = memory(), e = editor()
  cleanups.push(bindEditorSettings(e, f.preference))
  e.set({ rulers: true, snap: false, checkerboard: true })
  f.storage.setItem.mockClear()
  expect(e.load(blank('A different design'))).toBe(true)
  expect(e.state).toMatchObject({ rulers: true, snap: false, checkerboard: true })
  expect(e.state.doc.name).toBe('A different design')
  expect(f.storage.setItem).not.toHaveBeenCalled()
  expect(f.values.get(SETTINGS_PREFERENCE_KEY)).not.toContain('design')
})
