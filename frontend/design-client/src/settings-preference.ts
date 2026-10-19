import { useSyncExternalStore } from 'react'
import type { Editor, EditorState } from './engine'

/** View aids only. Wheel zoom and keyboard profiles retain their existing stores. */
export const SETTINGS_PREFERENCE_KEY = 'forma.canvas-preferences.v1'
export const CANVAS_SETTING_KEYS = ['snap', 'snapPixels', 'pixelGrid', 'rulers', 'checkerboard', 'grid'] as const
export type CanvasSetting = typeof CANVAS_SETTING_KEYS[number]
export type CanvasSettings = Readonly<Record<CanvasSetting, boolean>>
export const DEFAULT_CANVAS_SETTINGS: CanvasSettings = Object.freeze({
  snap: true, snapPixels: true, pixelGrid: true, rulers: false, checkerboard: false, grid: false,
})
type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>
const equal = (a: CanvasSettings, b: CanvasSettings) => CANVAS_SETTING_KEYS.every(key => a[key] === b[key])
const fromEditor = (state: EditorState): CanvasSettings => ({
  snap: state.snap, snapPixels: state.snapPixels, pixelGrid: state.pixelGrid,
  rulers: !!state.rulers, checkerboard: state.checkerboard, grid: state.grid,
})

export function createSettingsPreference(storage: () => PreferenceStorage | undefined) {
  let initialized = false, snapshot = DEFAULT_CANVAS_SETTINGS
  let persistence: 'available' | 'session-only' = 'available'
  const listeners = new Set<() => void>()
  let eventWindow: Window | undefined
  const changed = () => listeners.forEach(listener => listener())
  function read() {
    initialized = true
    let raw: string | null
    try {
      const target = storage()
      if (!target) { persistence = 'session-only'; return }
      raw = target.getItem(SETTINGS_PREFERENCE_KEY)
      persistence = 'available'
    } catch { persistence = 'session-only'; return }
    let parsed: unknown
    try { parsed = raw === null ? null : JSON.parse(raw) } catch { parsed = null }
    const next = { ...DEFAULT_CANVAS_SETTINGS }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const key of CANVAS_SETTING_KEYS) {
        const value = (parsed as Record<string, unknown>)[key]
        if (typeof value === 'boolean') next[key] = value
      }
    }
    if (!equal(snapshot, next)) snapshot = Object.freeze(next)
  }
  const external = (event: StorageEvent) => {
    if (event.key !== SETTINGS_PREFERENCE_KEY && event.key !== null) return
    if (event.storageArea) {
      try { if (event.storageArea !== storage()) return } catch { return }
    }
    read(); changed()
  }
  const getSnapshot = () => { if (!initialized) read(); return snapshot }
  return {
    getSnapshot,
    getPersistenceSnapshot: () => { if (!initialized) read(); return persistence },
    /** Invalid patches are rejected atomically; failed writes keep a usable session value. */
    set(patch: Partial<CanvasSettings>) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
        Object.entries(patch).some(([key, value]) => !CANVAS_SETTING_KEYS.includes(key as CanvasSetting) || typeof value !== 'boolean')) return false
      const next = { ...getSnapshot(), ...patch }
      if (!equal(snapshot, next)) snapshot = Object.freeze(next)
      let persisted = false
      try {
        const target = storage()
        target?.setItem(SETTINGS_PREFERENCE_KEY, JSON.stringify(snapshot))
        persisted = !!target
      } catch { /* Storage denial/quota must never discard the active preference. */ }
      persistence = persisted ? 'available' : 'session-only'
      changed()
      return persisted
    },
    reset() { return this.set(DEFAULT_CANVAS_SETTINGS) },
    subscribe(listener: () => void) {
      getSnapshot()
      listeners.add(listener)
      if (listeners.size === 1 && typeof window !== 'undefined') {
        eventWindow = window
        eventWindow.addEventListener('storage', external)
      }
      return () => {
        listeners.delete(listener)
        if (!listeners.size) { eventWindow?.removeEventListener('storage', external); eventWindow = undefined }
      }
    },
  }
}

export const settingsPreference = createSettingsPreference(() => typeof localStorage === 'undefined' ? undefined : localStorage)
export function useSettingsPersistence() {
  return useSyncExternalStore(settingsPreference.subscribe, settingsPreference.getPersistenceSnapshot, () => 'available' as const)
}

/** Mount once for the Editor lifetime, not for the dialog lifetime. Existing view
 * menus and shortcuts share the same values. Camera/document notifications only
 * compare six booleans: no storage read/write, snapshot allocation, or React update. */
export function bindEditorSettings(editor: Editor, preference = settingsPreference) {
  let applying = false, previous = preference.getSnapshot()
  const apply = () => {
    const next = preference.getSnapshot()
    previous = next
    if (CANVAS_SETTING_KEYS.every(key => !!editor.state[key] === next[key])) return
    applying = true
    try { editor.set(next) } finally { applying = false }
  }
  apply()
  const stopPreference = preference.subscribe(apply)
  const stopEditor = editor.subscribe(() => {
    if (applying || CANVAS_SETTING_KEYS.every(key => !!editor.state[key] === previous[key])) return
    previous = fromEditor(editor.state)
    preference.set(previous)
  })
  return () => { stopEditor(); stopPreference() }
}
