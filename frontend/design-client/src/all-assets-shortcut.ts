/** Sketch's All Assets shortcut is ⇧⌘E. Shift+E without Command stays the Figma eraser / prototype chord. */
export function matchesAllAssetsShortcut(event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; repeat?: boolean; isComposing?: boolean }, platform: 'mac' | 'windows' | 'linux'): boolean {
  if (event.repeat || event.altKey || event.isComposing) return false
  if (event.key.toLowerCase() !== 'e' || !event.shiftKey) return false
  return platform === 'mac' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}
