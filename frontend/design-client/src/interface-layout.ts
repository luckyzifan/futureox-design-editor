import { interfacePreference, type UiMode } from './interface-preference'
import { shortcutPreference } from './shortcut-preference'
import type { ShortcutProfile } from './shortcut-profiles'

/** Layout chords. Checked against shortcut-profiles: Mod+F is Sketch
 * frame-selection on desktop, Mod+Alt+G frames a selection, and Mod+0/1/2/3
 * and Shift+0/1/2 are zoom. Alt is what keeps these free. */
export const FIGMA_LAYOUT_COMBO = 'Mod+Alt+F'
export const SKETCH_LAYOUT_COMBO = 'Mod+Alt+S'

export function shortcutProfileForUiMode(mode: UiMode): ShortcutProfile {
  return mode === 'sketch' ? 'sketch-like' : 'figma-like'
}

export function applyInterfaceLayout(mode: UiMode) {
  interfacePreference.set({ uiMode: mode })
  shortcutPreference.set(shortcutProfileForUiMode(mode))
}

export function interfaceLayoutFromShortcut(event: {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat?: boolean
}): UiMode | null {
  if (event.repeat || event.shiftKey || !event.altKey) return null
  if (!(event.metaKey || event.ctrlKey) || (event.metaKey && event.ctrlKey)) return null
  const key = event.key.toLowerCase()
  if (key === 'f') return 'figma'
  if (key === 's') return 'sketch'
  return null
}
