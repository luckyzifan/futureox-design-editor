import type { EditorCommand } from './editor-commands'
import { TOOL_COMMANDS } from './tool-registry'

export type ShortcutProfile = 'figma-like' | 'sketch-like'
export type ShortcutPlatform = 'mac' | 'windows' | 'linux'
export type ShortcutAction = EditorCommand | 'toggle-lock' | 'toggle-visibility'
export type ShortcutContext = { profile: ShortcutProfile; platform: ShortcutPlatform; desktop?: boolean }
export type ShortcutBinding = { command: ShortcutAction; combo: string; repeat?: boolean }
export type ShortcutKey = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat' | 'isComposing' | 'defaultPrevented'> & { keyCode?: number; getModifierState?: (key: string) => boolean }
export function shortcutPlatform(platform = typeof navigator === 'undefined' ? '' : navigator.platform): ShortcutPlatform {
  return /Mac|iPhone|iPad/.test(platform) ? 'mac' : /Win/.test(platform) ? 'windows' : 'linux'
}
const common: ShortcutBinding[] = [
  { command: 'undo', combo: 'Mod+Z' }, { command: 'redo', combo: 'Mod+Shift+Z' },
  { command: 'copy', combo: 'Mod+C' }, { command: 'cut', combo: 'Mod+X' }, { command: 'paste', combo: 'Mod+V' },
  { command: 'paste-over-selection', combo: 'Mod+Shift+V' }, { command: 'duplicate', combo: 'Mod+D' },
  { command: 'group', combo: 'Mod+G' }, { command: 'ungroup', combo: 'Mod+Shift+G' },
  { command: 'select-all', combo: 'Mod+A' }, { command: 'rename', combo: 'F2' },
  { command: 'delete', combo: 'Backspace' }, { command: 'delete', combo: 'Delete' },
  { command: 'copy-properties', combo: 'Mod+Alt+C' }, { command: 'paste-properties', combo: 'Mod+Alt+V' },
  { command: 'frame-selection', combo: 'Mod+Alt+G' },
  // Existing local editor actions remain shared across both presets.
  { command: 'create-component', combo: 'Mod+Alt+K' }, { command: 'copy-as-png', combo: 'Mod+Shift+C' },
  { command: 'select-inverse', combo: 'Mod+Shift+A' }, { command: 'select-matching', combo: 'Mod+Alt+A' },
  { command: 'toggle-lock', combo: 'Mod+Shift+L' }, { command: 'toggle-visibility', combo: 'Mod+Shift+H' },
  { command: 'flip-horizontal', combo: 'Shift+H' }, { command: 'flip-vertical', combo: 'Shift+V' },
  { command: 'bring-forward', combo: 'Mod+]' }, { command: 'send-backward', combo: 'Mod+[' },
  { command: 'bring-to-front', combo: 'Mod+Alt+]' }, { command: 'send-to-back', combo: 'Mod+Alt+[' },
  { command: 'zoom-in', combo: '+', repeat: true }, { command: 'zoom-in', combo: '=', repeat: true },
  { command: 'zoom-in', combo: 'Mod++', repeat: true }, { command: 'zoom-in', combo: 'Mod+=', repeat: true },
  { command: 'zoom-out', combo: '-', repeat: true }, { command: 'zoom-out', combo: 'Shift+-', repeat: true }, { command: 'zoom-out', combo: 'Mod+-', repeat: true },
  // Browser-safe aliases remain available in both presets.
  { command: 'zoom-100', combo: 'Shift+0' }, { command: 'zoom-fit', combo: 'Shift+1' }, { command: 'zoom-selection', combo: 'Shift+2' },
]
/** A bounded preset over existing commands, not a promise of product parity.
 * Sources and deliberate browser adaptations are recorded in SHORTCUT_PROFILES.md. */
const bindingCache = new Map<string, readonly ShortcutBinding[]>()
export function shortcutBindings({ profile, platform, desktop = false }: ShortcutContext): readonly ShortcutBinding[] {
  const cacheKey = `${profile}:${platform}:${desktop}`
  const cached = bindingCache.get(cacheKey)
  if (cached) return cached
  const tools = new Map<string, string | undefined>(TOOL_COMMANDS.filter(c => c.tool && c.shortcut).map(c => [c.id, c.shortcut]))
  tools.set('set-tool-arrow', 'Shift+L')
  tools.set('set-tool-pencil', 'Shift+P')
  const bindings = common.map(binding => ({ ...binding }))
  if (profile === 'sketch-like') {
    tools.set('set-tool-default', undefined); tools.set('set-tool-pen', 'V'); tools.set('set-tool-pencil', 'P')
    tools.set('set-tool-slice', 'E'); tools.set('set-tool-eraser', undefined); tools.set('set-tool-comments', 'N')
    tools.set('set-tool-eyedropper', platform === 'mac' ? 'Ctrl+C' : 'Shift+I')
    tools.set('set-tool-section', undefined)
    bindings.push({ command: 'auto-layout', combo: 'Shift+S' }, { command: 'remove-auto-layout', combo: 'Alt+Shift+S' })
    for (const [key, dimension, direction] of [['ArrowRight', 'width', 'increase'], ['ArrowLeft', 'width', 'decrease'], ['ArrowDown', 'height', 'increase'], ['ArrowUp', 'height', 'decrease']] as const) {
      bindings.push({ command: `resize-${dimension}-${direction}`, combo: `Mod+${key}`, repeat: true },
        { command: `resize-${dimension}-${direction}-large`, combo: `Mod+Shift+${key}`, repeat: true })
    }
    if (desktop) bindings.unshift({ command: 'new-page', combo: 'Mod+Shift+N' }, { command: 'zoom-100', combo: 'Mod+0' }, { command: 'zoom-fit', combo: 'Mod+1' }, { command: 'zoom-selection', combo: 'Mod+2' }, { command: 'center-selection', combo: 'Mod+3' }, { command: 'frame-selection', combo: 'Mod+F' })
  } else {
    bindings.push({ command: 'auto-layout', combo: 'Shift+A' }, { command: 'remove-auto-layout', combo: 'Alt+Shift+A' })
    // Figma documents Shift, rather than Alt, for the Windows front/back chord.
    if (platform !== 'mac') for (const binding of bindings) {
      if (binding.command === 'bring-to-front') binding.combo = 'Mod+Shift+]'
      if (binding.command === 'send-to-back') binding.combo = 'Mod+Shift+['
    }
    bindings.unshift({ command: 'bring-to-front', combo: ']' }, { command: 'send-to-back', combo: '[' })
    if (desktop) bindings.push({ command: 'zoom-100', combo: 'Mod+0' })
  }
  if (desktop) bindings.push({ command: 'ungroup', combo: 'Mod+Backspace' }, { command: 'ungroup', combo: 'Mod+Delete' })
  if (desktop) bindings.unshift({ command: 'rename', combo: 'Mod+R' }, { command: 'paste-to-replace', combo: 'Mod+Shift+R' })
  if (platform !== 'mac') bindings.push({ command: 'redo', combo: 'Mod+Y' })
  bindings.push({ command: 'mask-selection', combo: platform === 'mac' ? 'Mod+Ctrl+M' : 'Mod+Alt+M' })
  for (const [command, combo] of tools) if (combo) bindings.push({ command: command as EditorCommand, combo })
  if (profile === 'figma-like') bindings.push({ command: 'set-tool-pencil', combo: 'Alt+P' })
  const result = Object.freeze(bindings.map(binding => Object.freeze(binding)))
  bindingCache.set(cacheKey, result)
  return result
}
function matches(event: ShortcutKey, combo: string, platform: ShortcutPlatform) {
  // A trailing '+' is the actual plus key, not an empty chord component.
  const key = combo.endsWith('+') ? '+' : combo.split('+').at(-1)!
  const modifiers = (key === '+' ? combo.slice(0, -1) : combo.slice(0, -key.length)).split('+')
  const mod = modifiers.includes('Mod')
  const meta = modifiers.includes('Meta') || (mod && platform === 'mac')
  const ctrl = modifiers.includes('Ctrl') || (mod && platform !== 'mac')
  const shift = modifiers.includes('Shift'), alt = modifiers.includes('Alt')
  // '+' requires Shift on common layouts, but not on a keypad or all layouts.
  if (event.metaKey !== meta || event.ctrlKey !== ctrl || event.altKey !== alt || (key !== '+' && event.shiftKey !== shift)) return false
  if (shift && ((key === '[' && event.code === 'BracketLeft') || (key === ']' && event.code === 'BracketRight'))) return true
  if (key === '-' && shift && event.code === 'Minus') return true
  if (/^\d$/.test(key) && shift && event.code === `Digit${key}`) return true
  if (event.key.toLowerCase() === key.toLowerCase()) return true
  // Explicit US/Generic Option outputs only. Preserve logical ASCII keys on
  // other layouts; never guess a base key for unknown symbols or dead keys.
  if (platform === 'mac' && alt && !/^[\x00-\x7f]+$/.test(event.key)) {
    const optionOutputs: Record<string, readonly [string, string, boolean]> = {
      '©': ['G', 'KeyG', false], 'Å': ['A', 'KeyA', true],
      'å': ['A', 'KeyA', false], 'π': ['P', 'KeyP', false],
      'ç': ['C', 'KeyC', false], '√': ['V', 'KeyV', false],
      '“': ['[', 'BracketLeft', false], '‘': [']', 'BracketRight', false],
    }
    const known = optionOutputs[event.key]
    return !!known && key.toUpperCase() === known[0] && event.code === known[1] && event.shiftKey === known[2]
  }
  return false
}
export function resolveShortcut(event: ShortcutKey, context: ShortcutContext): ShortcutBinding | null {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.key === 'Dead' || event.key === 'Process' || event.getModifierState?.('AltGraph')) return null
  return shortcutBindings(context).find(binding => matches(event, binding.combo, context.platform)) || null
}
export function shortcutLabel(command: ShortcutAction, context: ShortcutContext): string | undefined {
  const normalized = command === 'lock-selection' || command === 'unlock-selection' ? 'toggle-lock' : command === 'hide-selection' || command === 'show-selection' ? 'toggle-visibility' : command
  const combo = shortcutBindings(context).find(binding => binding.command === normalized)?.combo
  return combo ? formatShortcutCombo(combo, context.platform) : undefined
}
/** File/host commands share the same modifier presentation as editor commands. */
export function formatShortcutCombo(combo: string, platform: ShortcutPlatform): string {
  const names: Record<string, string> = platform === 'mac' ? { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Backspace: '⌫' } : { Mod: 'Ctrl', Backspace: 'Backspace' }
  if (combo.endsWith('+')) return `${combo.slice(0, -1).split('+').filter(Boolean).map(part => names[part] || part).join(' + ')}${combo.length > 1 ? ' + ' : ''}+`
  return combo.split('+').map(part => names[part] || part).join(platform === 'mac' ? ' ' : '+')
}
export function toolShortcutLabel(tool: string, context: ShortcutContext): string {
  const command = TOOL_COMMANDS.find(entry => entry.tool === tool)?.id
  return command ? shortcutLabel(command as EditorCommand, context) || '' : ''
}
