import { useSyncExternalStore } from 'react'
import type { ShortcutProfile } from './shortcut-profiles'
export const SHORTCUT_PROFILE_KEY = 'forma.shortcut-profile.v1'
const valid = (value: unknown): value is ShortcutProfile => value === 'figma-like' || value === 'sketch-like'
export function createShortcutPreference(storage: () => Pick<Storage, 'getItem' | 'setItem'> | undefined) {
  let fallback: ShortcutProfile = 'figma-like', volatile = false
  const listeners = new Set<() => void>()
  const changed = () => listeners.forEach(listener => listener())
  const external = (event: StorageEvent) => { if (event.key === SHORTCUT_PROFILE_KEY || event.key === null) { volatile = false; changed() } }
  return {
    getSnapshot: (): ShortcutProfile => {
      if (volatile) return fallback
      try { const value = storage()?.getItem(SHORTCUT_PROFILE_KEY); return valid(value) ? value : 'figma-like' } catch { return fallback }
    },
    set(profile: ShortcutProfile) {
      if (!valid(profile)) return false
      fallback = profile
      let persisted = false
      try { const target = storage(); target?.setItem(SHORTCUT_PROFILE_KEY, profile); persisted = !!target } catch { /* Keep the session usable when storage is full/disabled. */ }
      volatile = !persisted; changed(); return persisted
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1 && typeof window !== 'undefined') window.addEventListener('storage', external)
      return () => { listeners.delete(listener); if (!listeners.size && typeof window !== 'undefined') window.removeEventListener('storage', external) }
    },
  }
}
export const shortcutPreference = createShortcutPreference(() => typeof localStorage === 'undefined' ? undefined : localStorage)
export function useShortcutProfile() { return useSyncExternalStore(shortcutPreference.subscribe, shortcutPreference.getSnapshot, () => 'figma-like' as const) }
