import { useSyncExternalStore } from 'react'
import { DEFAULT_RENDER_MEMORY_TIER, validRenderMemoryTier, type RenderMemoryTier } from './kernel/page-memory-policy'
export const PAGE_MEMORY_PREFERENCE_KEY = 'core-page-memory-tier-v1'
export function createPageMemoryPreference(storage: () => Pick<Storage, 'getItem' | 'setItem'> | undefined) {
  let initialized = false, snapshot = DEFAULT_RENDER_MEMORY_TIER, persistence: 'available' | 'session-only' = 'available'
  const listeners = new Set<() => void>()
  let eventWindow: Window | undefined
  const changed = () => listeners.forEach(listener => listener())
  const read = () => {
    initialized = true
    try {
      const target = storage(), raw = target?.getItem(PAGE_MEMORY_PREFERENCE_KEY)
      persistence = target ? 'available' : 'session-only'
      snapshot = validRenderMemoryTier(raw) ? raw : DEFAULT_RENDER_MEMORY_TIER
    } catch { persistence = 'session-only' }
  }
  const getSnapshot = () => { if (!initialized) read(); return snapshot }
  const external = (event: StorageEvent) => {
    if (event.key !== PAGE_MEMORY_PREFERENCE_KEY && event.key !== null) return
    if (event.storageArea) { try { if (event.storageArea !== storage()) return } catch { return } }
    read(); changed()
  }
  return {
    getSnapshot,
    getPersistenceSnapshot: () => { getSnapshot(); return persistence },
    set(value: RenderMemoryTier) {
      if (!validRenderMemoryTier(value)) return false
      getSnapshot(); snapshot = value
      let persisted = false
      try { const target = storage(); target?.setItem(PAGE_MEMORY_PREFERENCE_KEY, value); persisted = !!target } catch { /* Session preference still takes effect. */ }
      persistence = persisted ? 'available' : 'session-only'; changed(); return persisted
    },
    reset() { return this.set(DEFAULT_RENDER_MEMORY_TIER) },
    subscribe(listener: () => void) {
      getSnapshot(); listeners.add(listener)
      if (listeners.size === 1 && typeof window !== 'undefined') { eventWindow = window; eventWindow.addEventListener('storage', external) }
      return () => { listeners.delete(listener); if (!listeners.size) { eventWindow?.removeEventListener('storage', external); eventWindow = undefined } }
    },
  }
}
export const pageMemoryPreference = createPageMemoryPreference(() => typeof localStorage === 'undefined' ? undefined : localStorage)
export function useRenderMemoryTier() { return useSyncExternalStore(pageMemoryPreference.subscribe, pageMemoryPreference.getSnapshot, () => DEFAULT_RENDER_MEMORY_TIER) }
