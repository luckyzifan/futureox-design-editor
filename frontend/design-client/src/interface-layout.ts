import { interfacePreference, type UiMode } from './interface-preference'
import { shortcutPreference } from './shortcut-preference'
import type { ShortcutProfile } from './shortcut-profiles'
import { LAYOUT_GAP_LIMIT, type AutoLayout } from './model'
import type { Tool } from './engine'

export const sketchInsertTools = ['frame', 'graphic', 'section', 'slice', 'hotspot', 'rectangle', 'ellipse', 'line',
  'arrow', 'polygon', 'star', 'pen', 'pencil', 'text'] as const
export const sketchToolMenu = ['select', 'hand', 'scale', 'zoom', 'pencil', 'brush', 'eraser', 'comments', 'eyedropper'] as const
const sketchToolbarTools = new Set<Tool>([...sketchInsertTools, ...sketchToolMenu, 'vector'])
export function sketchToolbarSupportsTool(tool: Tool) { return sketchToolbarTools.has(tool) }

/** Grid tracks and Figma's cross-axis spacing stop at zero in their controls. */
export function layoutGapMinimum(mode: AutoLayout['mode'], field: 'gap' | 'lineGap', uiMode: UiMode) {
  return mode === 'grid' || (field === 'lineGap' && uiMode === 'figma') ? 0 : -LAYOUT_GAP_LIMIT
}

/** On desktop, Mod+F frames the Sketch selection or opens Figma Find.
 * The Sketch layout and shortcut profile together assign Mod+Alt+F to
 * the layer search field. The layout buttons remain available in either mode. */
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

/** Native Sketch Option+Command+F focuses layer find. It owns that chord only
 * for the default Sketch shortcut scheme on the Sketch layout. Figma-like
 * profiles keep the layout switch, and the Figma layout does not take the
 * chord (Figma find is a different shortcut). */
export function sketchLayerFindOwnsChord(event: {
  key: string
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat?: boolean
}, profile: ShortcutProfile, uiMode: UiMode): boolean {
  return profile === 'sketch-like' && uiMode === 'sketch' && interfaceLayoutFromShortcut(event) === 'figma'
}
