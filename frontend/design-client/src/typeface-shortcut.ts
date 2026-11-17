import { shortcutPlatform, type ShortcutKey } from './shortcut-profiles'

export function matchesTypefaceShortcut(event: ShortcutKey): boolean {
  const primary = shortcutPlatform() === 'mac' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  return primary && !event.altKey && !event.shiftKey && !event.defaultPrevented && !event.repeat &&
    !event.isComposing && event.keyCode !== 229 && event.key.toLowerCase() === 't'
}

export function openTypefaceSelect(select: HTMLSelectElement | null): boolean {
  if (!select || select.disabled) return false
  select.focus()
  if (document.activeElement !== select) return false
  try { select.showPicker?.() }
  catch (error) {
    // Embedded or less capable browsers can still navigate the focused select
    // even when the native popup requires a different activation context.
    if (!(error instanceof DOMException)) throw error
  }
  return true
}
