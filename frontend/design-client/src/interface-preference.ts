import { useSyncExternalStore } from 'react'
import { interfaceText } from './interface-messages'

export type InterfaceLocale = 'zh-CN' | 'en'
export type UiMode = 'figma' | 'sketch'
/** Official Figma 126.10.13 right inspector, in CSS pixels. */
export const FIGMA_INSPECTOR_WIDTH = 241
/** Official Sketch 2025.1.3 right inspector is 239.5pt; the accepted width is 240. */
export const SKETCH_INSPECTOR_WIDTH = 240
/** Previous shared default. It was wider than both official inspectors, so a saved 280 is that default, not a custom size. */
export const LEGACY_SHARED_INSPECTOR_WIDTH = 280
export const RIGHT_PANEL_MIN = SKETCH_INSPECTOR_WIDTH
export const RIGHT_PANEL_MAX = 480
export type InspectorWidths = Readonly<{ figma: number; sketch: number }>
export const OFFICIAL_INSPECTOR_WIDTHS: InspectorWidths = Object.freeze({ figma: FIGMA_INSPECTOR_WIDTH, sketch: SKETCH_INSPECTOR_WIDTH })
export type InterfacePreferences = Readonly<{ leftWidth: number; rightWidth: number; inspectorWidths: InspectorWidths; leftOpen: boolean; rightOpen: boolean; reducedMotion: boolean; rememberViewport: boolean; locale: InterfaceLocale; uiMode: UiMode }>
export const INTERFACE_PREFERENCE_KEY = 'forma.interface-preferences.v1'
export function officialInspectorWidth(mode: UiMode) { return mode === 'sketch' ? SKETCH_INSPECTOR_WIDTH : FIGMA_INSPECTOR_WIDTH }
export const DEFAULT_INTERFACE_PREFERENCES: InterfacePreferences = Object.freeze({ leftWidth: 248, rightWidth: FIGMA_INSPECTOR_WIDTH, inspectorWidths: OFFICIAL_INSPECTOR_WIDTHS, leftOpen: true, rightOpen: true, reducedMotion: false, rememberViewport: false, locale: 'zh-CN', uiMode: 'figma' })
export function panelWidth(value: number, side: 'left' | 'right') { return Math.round(Math.min(side === 'left' ? 480 : RIGHT_PANEL_MAX, Math.max(side === 'left' ? 208 : RIGHT_PANEL_MIN, value))) }
function finitePanel(value: unknown, side: 'left' | 'right') { return typeof value === 'number' && Number.isFinite(value) ? panelWidth(value, side) : undefined }
function readInspectorWidths(value: Record<string, unknown>): InspectorWidths {
  const raw = value.inspectorWidths
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>
    return Object.freeze({ figma: finitePanel(record.figma, 'right') ?? FIGMA_INSPECTOR_WIDTH, sketch: finitePanel(record.sketch, 'right') ?? SKETCH_INSPECTOR_WIDTH })
  }
  const legacy = finitePanel(value.rightWidth, 'right')
  if (legacy === undefined || legacy === LEGACY_SHARED_INSPECTOR_WIDTH) return OFFICIAL_INSPECTOR_WIDTHS
  return Object.freeze({ figma: legacy, sketch: legacy })
}
export function createInterfacePreference(storage: () => Pick<Storage, 'getItem' | 'setItem'> | undefined) {
  let snapshot = DEFAULT_INTERFACE_PREFERENCES, initialized = false, persisted = true
  const listeners = new Set<() => void>()
  const sanitize = (input: unknown): InterfacePreferences => {
    const value = input && typeof input === 'object' ? input as Record<string, unknown> : {}
    const uiMode: UiMode = value.uiMode === 'sketch' ? 'sketch' : 'figma'
    const inspectorWidths = readInspectorWidths(value)
    return Object.freeze({ ...DEFAULT_INTERFACE_PREFERENCES,
      ...Object.fromEntries(['leftOpen', 'rightOpen', 'reducedMotion', 'rememberViewport'].flatMap(key => typeof value[key] === 'boolean' ? [[key, value[key]]] : [])),
      leftWidth: finitePanel(value.leftWidth, 'left') ?? 248,
      inspectorWidths,
      rightWidth: inspectorWidths[uiMode],
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
      const merged: Record<string, unknown> = { ...current, ...patch }
      if (patch.inspectorWidths === undefined && typeof patch.rightWidth === 'number' && Number.isFinite(patch.rightWidth)) {
        const mode: UiMode = patch.uiMode === 'sketch' || patch.uiMode === 'figma' ? patch.uiMode : current.uiMode
        merged.inspectorWidths = { ...current.inspectorWidths, [mode]: patch.rightWidth }
      }
      snapshot = sanitize(merged)
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
