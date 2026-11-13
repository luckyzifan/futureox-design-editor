import { useSyncExternalStore } from 'react'
import { interfaceText } from './interface-messages'

export type InterfaceLocale = 'zh-CN' | 'en'
export type UiMode = 'figma' | 'sketch'
/** Official pages + layers column. Figma 126.10.13 is 240pt; Sketch 2025.1.3 is 230pt. */
export const FIGMA_LAYERS_WIDTH = 240
export const SKETCH_LAYERS_WIDTH = 230
/** Shared width shipped before each layout had its own column. */
export const LEGACY_SHARED_LAYERS_WIDTH = 248
export type LayersWidths = Readonly<{ figma: number; sketch: number }>
export function officialLayersWidth(mode: UiMode): number {
  return mode === 'sketch' ? SKETCH_LAYERS_WIDTH : FIGMA_LAYERS_WIDTH
}
export const DEFAULT_LAYERS_WIDTHS: LayersWidths = Object.freeze({ figma: FIGMA_LAYERS_WIDTH, sketch: SKETCH_LAYERS_WIDTH })
export type InterfacePreferences = Readonly<{ leftWidth: number; leftWidths: LayersWidths; rightWidth: number; leftOpen: boolean; rightOpen: boolean; reducedMotion: boolean; rememberViewport: boolean; locale: InterfaceLocale; uiMode: UiMode }>
export const INTERFACE_PREFERENCE_KEY = 'forma.interface-preferences.v1'
export const DEFAULT_INTERFACE_PREFERENCES: InterfacePreferences = Object.freeze({ leftWidth: FIGMA_LAYERS_WIDTH, leftWidths: DEFAULT_LAYERS_WIDTHS, rightWidth: 280, leftOpen: true, rightOpen: true, reducedMotion: false, rememberViewport: false, locale: 'zh-CN', uiMode: 'figma' })
export function panelWidth(value: number, side: 'left' | 'right') { return Math.round(Math.min(480, Math.max(side === 'left' ? 208 : 260, value))) }
function finiteLeft(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? panelWidth(value, 'left') : fallback
}
/** A saved 248 is the old shared default. Any other lone leftWidth was a shared resize and starts both layouts; later drags stay on the active layout. */
export function layersWidthsFrom(input: unknown): LayersWidths {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const raw = value.leftWidths
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>
    return Object.freeze({ figma: finiteLeft(record.figma, FIGMA_LAYERS_WIDTH), sketch: finiteLeft(record.sketch, SKETCH_LAYERS_WIDTH) })
  }
  const legacy = typeof value.leftWidth === 'number' && Number.isFinite(value.leftWidth) ? value.leftWidth : null
  if (legacy === null || legacy === LEGACY_SHARED_LAYERS_WIDTH) return DEFAULT_LAYERS_WIDTHS
  const chosen = panelWidth(legacy, 'left')
  return Object.freeze({ figma: chosen, sketch: chosen })
}
export function createInterfacePreference(storage: () => Pick<Storage, 'getItem' | 'setItem'> | undefined) {
  let snapshot = DEFAULT_INTERFACE_PREFERENCES, initialized = false, persisted = true
  const listeners = new Set<() => void>()
  const sanitize = (input: unknown): InterfacePreferences => {
    const value = input && typeof input === 'object' ? input as Record<string, unknown> : {}
    const uiMode: UiMode = value.uiMode === 'sketch' ? 'sketch' : 'figma'
    const leftWidths = layersWidthsFrom(value)
    return Object.freeze({ ...DEFAULT_INTERFACE_PREFERENCES,
      ...Object.fromEntries(['leftOpen', 'rightOpen', 'reducedMotion', 'rememberViewport'].flatMap(key => typeof value[key] === 'boolean' ? [[key, value[key]]] : [])),
      leftWidths,
      leftWidth: leftWidths[uiMode],
      rightWidth: typeof value.rightWidth === 'number' && Number.isFinite(value.rightWidth) ? panelWidth(value.rightWidth, 'right') : 280,
      locale: value.locale === 'en' ? 'en' : 'zh-CN',
      uiMode,
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
      const current = getSnapshot()
      const nextMode: UiMode = patch.uiMode === 'sketch' ? 'sketch' : patch.uiMode === 'figma' ? 'figma' : current.uiMode
      const leftWidths = { figma: current.leftWidths.figma, sketch: current.leftWidths.sketch }
      if (patch.leftWidths && typeof patch.leftWidths === 'object') {
        if (typeof patch.leftWidths.figma === 'number' && Number.isFinite(patch.leftWidths.figma)) leftWidths.figma = panelWidth(patch.leftWidths.figma, 'left')
        if (typeof patch.leftWidths.sketch === 'number' && Number.isFinite(patch.leftWidths.sketch)) leftWidths.sketch = panelWidth(patch.leftWidths.sketch, 'left')
      }
      if (typeof patch.leftWidth === 'number' && Number.isFinite(patch.leftWidth)) {
        const edited: UiMode = patch.leftWidths ? nextMode : current.uiMode
        leftWidths[edited] = panelWidth(patch.leftWidth, 'left')
      }
      snapshot = sanitize({ ...current, ...patch, uiMode: nextMode, leftWidths, leftWidth: leftWidths[nextMode] })
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
