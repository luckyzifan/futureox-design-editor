/** Input preferences stay local and never enter the document/undo graph. */
export const NUDGE_PREFERENCE_KEY = 'forma.nudge-preferences.v1'
export type NudgeSettings = Readonly<{ small: number; big: number }>
export const DEFAULT_NUDGE_SETTINGS: NudgeSettings = Object.freeze({ small: 1, big: 10 })
export function validNudgeSettings(value: unknown): value is NudgeSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const { small, big } = value as NudgeSettings
  return [small, big].every(value => typeof value === 'number' && Number.isFinite(value) && value >= .01 && value <= 1e6) && big >= small
}
export function createNudgePreference(storage: () => Pick<Storage, 'getItem' | 'setItem'> | undefined) {
  let initialized = false, snapshot = DEFAULT_NUDGE_SETTINGS, persistence: 'available' | 'session-only' = 'available'
  const listeners = new Set<() => void>()
  let eventWindow: Window | undefined
  const changed = () => listeners.forEach(listener => listener())
  const read = () => {
    initialized = true
    let value: unknown
    try {
      const target = storage(); persistence = target ? 'available' : 'session-only'
      const raw = target?.getItem(NUDGE_PREFERENCE_KEY)
      try { value = raw ? JSON.parse(raw) : null } catch { value = null }
    } catch { persistence = 'session-only'; return }
    const next = validNudgeSettings(value) ? { small: value.small, big: value.big } : DEFAULT_NUDGE_SETTINGS
    if (next.small !== snapshot.small || next.big !== snapshot.big) snapshot = Object.freeze(next)
  }
  const getSnapshot = () => { if (!initialized) read(); return snapshot }
  const external = (event: StorageEvent) => {
    if (event.key !== NUDGE_PREFERENCE_KEY && event.key !== null) return
    if (event.storageArea) { try { if (event.storageArea !== storage()) return } catch { return } }
    read(); changed()
  }
  return {
    getSnapshot,
    getPersistenceSnapshot: () => { getSnapshot(); return persistence },
    set(value: NudgeSettings) {
      if (!validNudgeSettings(value)) return false
      getSnapshot()
      if (snapshot.small !== value.small || snapshot.big !== value.big) snapshot = Object.freeze({ small: value.small, big: value.big })
      let persisted = false
      try { const target = storage(); target?.setItem(NUDGE_PREFERENCE_KEY, JSON.stringify(snapshot)); persisted = !!target } catch { /* Keep session value. */ }
      persistence = persisted ? 'available' : 'session-only'; changed(); return persisted
    },
    reset() { return this.set(DEFAULT_NUDGE_SETTINGS) },
    subscribe(listener: () => void) {
      getSnapshot(); listeners.add(listener)
      if (listeners.size === 1 && typeof window !== 'undefined') { eventWindow = window; eventWindow.addEventListener('storage', external) }
      return () => { listeners.delete(listener); if (!listeners.size) { eventWindow?.removeEventListener('storage', external); eventWindow = undefined } }
    },
  }
}
export const nudgePreference = createNudgePreference(() => typeof localStorage === 'undefined' ? undefined : localStorage)
