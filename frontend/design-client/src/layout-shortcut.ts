import { shortcutTargetOwnsKeyboard } from './editor-shortcuts'
import { applyInterfaceLayout, interfaceLayoutFromShortcut, sketchLayerFindOwnsChord } from './interface-layout'
import { interfacePreference } from './interface-preference'
import { shortcutPreference } from './shortcut-preference'

/** Window bubble handler for the layout chords. Sketch find owns Option+Command+F
 * before this runs (capture). This still refuses the switch if that listener
 * is absent, and it leaves text, menus, and modals in possession of the key. */
export function applyInterfaceLayoutShortcut(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || shortcutTargetOwnsKeyboard(event.target)) return false
  if (sketchLayerFindOwnsChord(event, shortcutPreference.getSnapshot(), interfacePreference.getSnapshot().uiMode)) {
    event.preventDefault()
    return false
  }
  const mode = interfaceLayoutFromShortcut(event)
  if (!mode || (mode === 'sketch' && interfacePreference.getSnapshot().uiMode === 'sketch')) return false
  event.preventDefault()
  applyInterfaceLayout(mode)
  return true
}
