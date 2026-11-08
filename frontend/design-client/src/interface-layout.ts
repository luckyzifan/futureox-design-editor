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
  /** Physical key. US Mac Option+F / Option+S produce ƒ (U+0192) and ß (U+00DF), so `key` is not "f" / "s". */
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat?: boolean
}): UiMode | null {
  if (event.repeat || event.shiftKey || !event.altKey) return null
  if (!(event.metaKey || event.ctrlKey) || (event.metaKey && event.ctrlKey)) return null
  // Accept the physical F/S keys, and the plain letters tests and other platforms produce.
  // Do not map other Option symbols; an unknown character without KeyF/KeyS is not this chord.
  const key = event.key.toLowerCase()
  const letter = event.code === 'KeyF' || event.code === 'KeyS'
    ? (event.code === 'KeyF' ? 'f' : 's')
    : key === 'f' || key === 's' ? key : ''
  if (letter === 'f') return 'figma'
  if (letter === 's') return 'sketch'
  return null
}
