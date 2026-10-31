import { useSyncExternalStore } from 'react'
import { interfaceText } from './interface-messages'

export type InterfaceLocale = 'zh-CN' | 'en'
export type InterfacePreferences = Readonly<{ leftWidth: number; rightWidth: number; leftOpen: boolean; rightOpen: boolean; reducedMotion: boolean; rememberViewport: boolean; locale: InterfaceLocale }>
export const INTERFACE_PREFERENCE_KEY = 'forma.interface-preferences.v1'
export const DEFAULT_INTERFACE_PREFERENCES: InterfacePreferences = Object.freeze({ leftWidth: 248, rightWidth: 280, leftOpen: true, rightOpen: true, reducedMotion: false, rememberViewport: false, locale: 'zh-CN' })
export function panelWidth(value: number, side: 'left' | 'right') { return Math.round(Math.min(480, Math.max(side === 'left' ? 208 : 260, value))) }
export function createInterfacePreference(storage: () => Pick<Storage, 'getItem' | 'setItem'> | undefined) {
  let snapshot = DEFAULT_INTERFACE_PREFERENCES, initialized = false, persisted = true
  const listeners = new Set<() => void>()
  const sanitize = (input: unknown): InterfacePreferences => {
    const value = input && typeof input === 'object' ? input as Record<string, unknown> : {}
    return Object.freeze({ ...DEFAULT_INTERFACE_PREFERENCES,
      ...Object.fromEntries(['leftOpen', 'rightOpen', 'reducedMotion', 'rememberViewport'].flatMap(key => typeof value[key] === 'boolean' ? [[key, value[key]]] : [])),
      leftWidth: typeof value.leftWidth === 'number' && Number.isFinite(value.leftWidth) ? panelWidth(value.leftWidth, 'left') : 248,
      rightWidth: typeof value.rightWidth === 'number' && Number.isFinite(value.rightWidth) ? panelWidth(value.rightWidth, 'right') : 280,
      locale: value.locale === 'en' ? 'en' : 'zh-CN',
    })
  }
  const read = () => { initialized = true; try { const target = storage(); snapshot = sanitize(JSON.parse(target?.getItem(INTERFACE_PREFERENCE_KEY) || '{}')); persisted = !!target } catch { persisted = false } }
  const getSnapshot = () => { if (!initialized) read(); return snapshot }
  const external = (event: StorageEvent) => {
    // A sessionStorage event must not replace an unsaved local preference.
    try { if (event.storageArea && event.storageArea !== storage()) return } catch { return }
    if (event.key === INTERFACE_PREFERENCE_KEY || event.key === null) { read(); listeners.forEach(listener => listener()) } }
  return {
    getSnapshot,
    getPersistenceSnapshot: () => { getSnapshot(); return persisted },
    set(patch: Partial<InterfacePreferences>) {
      snapshot = sanitize({ ...getSnapshot(), ...patch })
      try { const target = storage(); target?.setItem(INTERFACE_PREFERENCE_KEY, JSON.stringify(snapshot)); persisted = !!target } catch { persisted = false }
      listeners.forEach(listener => listener()); return persisted
    },
    reset() { return this.set(DEFAULT_INTERFACE_PREFERENCES) },
    subscribe(listener: () => void) { getSnapshot(); listeners.add(listener); if (listeners.size === 1 && typeof window !== 'undefined') window.addEventListener('storage', external)
      return () => { listeners.delete(listener); if (!listeners.size && typeof window !== 'undefined') window.removeEventListener('storage', external) } },
  }
}
export const interfacePreference = createInterfacePreference(() => typeof localStorage === 'undefined' ? undefined : localStorage)
export function useInterfacePreferences() { return useSyncExternalStore(interfacePreference.subscribe, interfacePreference.getSnapshot, () => DEFAULT_INTERFACE_PREFERENCES) }
export { interfaceText } from './interface-messages'
export function useInterfaceText() { return interfaceText[useInterfacePreferences().locale] }
