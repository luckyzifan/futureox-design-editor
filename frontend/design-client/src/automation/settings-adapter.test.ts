import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '../engine'
import { blank } from '../model'
import { bindEditorSettings, createSettingsPreference, SETTINGS_PREFERENCE_KEY } from '../settings-preference'
import { createShortcutPreference, SHORTCUT_PROFILE_KEY } from '../shortcut-preference'
import { registerPendingEdit } from '../pending-edits'
import { createAutomationSettingsAdapter } from './settings-adapter'
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(fn => fn()); vi.unstubAllGlobals() })
function fixture() {
  const values = new Map<string, string>(), storage = { getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { values.set(key, value) }) }
  vi.stubGlobal('window', { localStorage: storage, addEventListener() {}, removeEventListener() {} })
  const editor = new Editor(blank('Settings CAS')), canvas = createSettingsPreference(() => storage), keyboard = createShortcutPreference(() => storage)
  cleanups.push(() => editor.dispose(), bindEditorSettings(editor, canvas))
  const adapter = createAutomationSettingsAdapter(editor, { canvas, keyboard, storage: () => storage }); cleanups.push(() => adapter.dispose())
  const guard = () => ({ documentId: editor.state.doc.id, session: editor.sessionGeneration, expectedRevision: editor.state.version })
  const update = (patch: Record<string, unknown>, expectedSettingsRevision = adapter.get().settingsRevision, mutationId: string = crypto.randomUUID()) => adapter.update({ patch, expectedSettingsRevision, mutationId }, guard(), new AbortController().signal)
  return { editor, canvas, keyboard, values, storage, adapter, guard, update }
}
describe('settings automation through real Editor and existing preference stores', () => {
  it('rejects invalid mutation identities before changing settings or recording receipts', () => {
    const f = fixture(), before = f.adapter.get()
    for (const mutationId of ['', 'save:1', 'save.1', 'x'.repeat(129), '非ASCII']) expect(() => f.update({ snap: false }, before.settingsRevision, mutationId)).toThrowError(expect.objectContaining({ code: 'INVALID_PARAMS' }))
    expect(f.adapter.get()).toEqual(before)
    expect(f.update({ snap: false }, before.settingsRevision, 'x'.repeat(128)).values.snap).toBe(false)
  })
  it('updates all 8 allowlisted preferences and persistence stores without editing document history', () => {
    const f = fixture(), document = f.editor.state.doc
    const result = f.update({ snap: false, snapPixels: false, pixelGrid: false, rulers: true, checkerboard: true, grid: true, scrollWheelZoom: true, shortcutProfile: 'sketch-like' })
    expect(result.values).toEqual({ snap: false, snapPixels: false, pixelGrid: false, rulers: true, checkerboard: true, grid: true, scrollWheelZoom: true, shortcutProfile: 'sketch-like' })
    expect(result.persistence).toBe('available'); expect(result.atomicDurability).toBe(false)
    expect(f.values.has(SETTINGS_PREFERENCE_KEY)).toBe(true); expect(f.values.get(SHORTCUT_PROFILE_KEY)).toBe('sketch-like'); expect(f.values.get('forma-scroll-wheel-zoom')).toBe('true')
    expect(f.editor.state.doc).toBe(document); expect(f.editor.canUndo).toBe(false)
  })
  it('tracks native/menu/store changes and rejects stale settings CAS', () => {
    const f = fixture(), first = f.adapter.get()
    f.editor.set({ grid: true }); const second = f.adapter.get(); expect(second.settingsRevision).toBeGreaterThan(first.settingsRevision)
    f.keyboard.set('sketch-like'); const third = f.adapter.get(); expect(third.settingsRevision).toBeGreaterThan(second.settingsRevision)
    f.editor.setScrollWheelZoom(true); expect(f.adapter.get().settingsRevision).toBeGreaterThan(third.settingsRevision)
    expect(() => f.update({ snap: false }, first.settingsRevision)).toThrow(expect.objectContaining({ code: 'SETTINGS_REVISION_CONFLICT' }))
    expect(f.editor.state.snap).toBe(true)
  })
  it('validates the complete patch before mutation and preserves drafts or wrong-session content', () => {
    const f = fixture(), before = f.adapter.get()
    for (const patch of [{ snap: false, password: 'forbidden' }, { snap: 'no' }, { shortcutProfile: 'shell' }, {}]) expect(() => f.update(patch)).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS' }))
    expect(f.adapter.get().values).toEqual(before.values); expect(f.storage.setItem).not.toHaveBeenCalled()
    const commit = vi.fn(() => true), stop = registerPendingEdit(f.editor, { dirty: () => true, commit }); cleanups.push(stop)
    expect(() => f.update({ snap: false })).toThrow(expect.objectContaining({ code: 'PENDING_EDITS' })); expect(commit).not.toHaveBeenCalled(); stop()
    expect(() => f.adapter.update({ patch: { snap: false }, expectedSettingsRevision: 0, mutationId: 'wrong' }, { ...f.guard(), session: 99 }, new AbortController().signal)).toThrow(expect.objectContaining({ code: 'STALE_SESSION' }))
  })
  it('reports partial localStorage failure as session-only and returns idempotent receipts', () => {
    const f = fixture(); f.storage.setItem.mockImplementation(() => { throw new Error('quota') })
    const revision = f.adapter.get().settingsRevision, result = f.update({ snap: false, shortcutProfile: 'sketch-like', scrollWheelZoom: true }, revision, 'same')
    expect(result.persistence).toBe('session-only'); expect(result.atomicDurability).toBe(false); expect(result.values.snap).toBe(false)
    const calls = f.storage.setItem.mock.calls.length
    expect(f.update({ snap: false, shortcutProfile: 'sketch-like', scrollWheelZoom: true }, revision, 'same')).toEqual(result); expect(f.storage.setItem).toHaveBeenCalledTimes(calls)
    expect(() => f.update({ snap: true }, revision, 'same')).toThrow(expect.objectContaining({ code: 'MUTATION_CONFLICT' }))
  })
  it('camera and unrelated editor notifications never read preference storage', () => {
    const f = fixture(); f.storage.getItem.mockClear(); f.storage.setItem.mockClear()
    for (let index = 0; index < 300; index++) f.editor.set({ message: `Frame ${index}` })
    expect(f.storage.getItem).not.toHaveBeenCalled(); expect(f.storage.setItem).not.toHaveBeenCalled()
  })
  it('fresh native grants get independent mutation receipts without retaining previous grant authority', () => {
    const f = fixture(), revision = f.adapter.get().settingsRevision, signal = new AbortController().signal
    const first = f.adapter.update({ patch: { snap: false }, expectedSettingsRevision: revision, mutationId: 'reuse' }, { ...f.guard(), grantSessionId: 'grant-one' }, signal)
    const second = f.adapter.update({ patch: { snap: true }, expectedSettingsRevision: first.settingsRevision, mutationId: 'reuse' }, { ...f.guard(), grantSessionId: 'grant-two' }, signal)
    expect(second.values.snap).toBe(true); expect(second.settingsRevision).toBeGreaterThan(first.settingsRevision)
  })

})
