import type { EditorCommand } from './editor-commands'
import { TOOL_COMMANDS } from './tool-registry'
import { interfacePreference, type FigmaKeyboardLayout, type UiMode } from './interface-preference'
import { sketchBooleanCommands, sketchBooleanCommandIds } from './sketch-boolean-commands'

export type ShortcutProfile = 'figma-like' | 'sketch-like'
export type ShortcutPlatform = 'mac' | 'windows' | 'linux'
export type ShortcutAction = EditorCommand | 'toggle-lock' | 'toggle-visibility' | 'open-command-search' | 'open-layer-find' | 'toggle-layout-guides' | 'toggle-pixel-grid' | 'toggle-pixel-snapping' | 'select-parent' | 'open-shortcut-reference' | 'keyboard-box-select' | 'decrease-font-size' | 'increase-font-size' | 'decrease-font-weight' | 'increase-font-weight' | 'decrease-letter-spacing' | 'increase-letter-spacing' | 'decrease-line-height' | 'increase-line-height' | 'toggle-text-underline' | 'text-bullet-list' | 'text-numbered-list'
export type ShortcutContext = { profile: ShortcutProfile; platform: ShortcutPlatform; desktop?: boolean; uiMode?: UiMode; keyboardLayout?: FigmaKeyboardLayout }
export type ShortcutBinding = { command: ShortcutAction; combo: string; repeat?: boolean; preserveFrameContents?: true; physicalCode?: string }
export type ShortcutKey = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat' | 'isComposing' | 'defaultPrevented'> & { keyCode?: number; getModifierState?: (key: string) => boolean }
export function shortcutProfileForUiMode(mode: UiMode): ShortcutProfile {
  return mode === 'sketch' ? 'sketch-like' : 'figma-like'
}
export function shortcutContextForLayout(context: ShortcutContext): ShortcutContext {
  const profile = context.uiMode ? shortcutProfileForUiMode(context.uiMode) : context.profile
  return profile === context.profile ? context : { ...context, profile }
}
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
  { command: 'create-component', combo: 'Mod+Alt+K' },
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
const figmaBindings: ShortcutBinding[] = [
  { command: 'copy-as-png', combo: 'Mod+Shift+C' },
  { command: 'toggle-outlines', combo: 'Mod+Shift+O' },
  { command: 'toggle-pixel-grid', combo: "Shift+'", physicalCode: 'Quote' },
  { command: 'toggle-pixel-snapping', combo: "Mod+Shift+'", physicalCode: 'Quote' },
  { command: 'open-shortcut-reference', combo: 'Ctrl+Shift+/', physicalCode: 'Slash' },
  { command: 'select-parent', combo: '\\' },
]

/** Bindings belong to the active editor layout; portable editing keys are shared. */
const bindingCache = new Map<string, readonly ShortcutBinding[]>()
export function shortcutBindings(context: ShortcutContext): readonly ShortcutBinding[] {
  const { profile, platform, desktop = false, uiMode } = shortcutContextForLayout(context)
  const keyboardLayout = context.keyboardLayout ?? (uiMode === 'figma' ? interfacePreference.getSnapshot().figmaKeyboardLayout : 'us-qwerty')
  const cacheKey = `${profile}:${platform}:${desktop}:${uiMode ?? ''}:${keyboardLayout}`
  const cached = bindingCache.get(cacheKey)
  if (cached) return cached
  const tools = new Map<string, string | undefined>(TOOL_COMMANDS.filter(c => c.tool && c.shortcut).map(c => [c.id, c.shortcut]))
  tools.set('set-tool-arrow', 'Shift+L')
  tools.set('set-tool-pencil', 'Shift+P')
  const sketchMacSelection = uiMode === 'sketch' && profile === 'sketch-like' && platform === 'mac'
  const bindings = common.filter(binding => (uiMode !== 'sketch' || binding.command !== 'select-matching') &&
    (!sketchMacSelection || binding.command !== 'select-inverse'))
    .map(binding => ({ ...binding }))
  if (uiMode === 'sketch' || !uiMode && profile === 'sketch-like') tools.delete('set-tool-brush')
  else bindings.push(...figmaBindings)
  if (uiMode === 'sketch') for (const command of sketchBooleanCommandIds) {
    const { letter } = sketchBooleanCommands[command]
    bindings.push({ command, combo: `Mod+Alt+${letter}`, physicalCode: `Key${letter}` })
  }
  if (uiMode === 'sketch' && platform === 'mac') bindings.unshift(
    { command: 'create-component', combo: 'Mod+Y' },
    { command: 'fit-pixel-bounds', combo: 'Ctrl+Mod+X' },
    { command: 'round-to-pixel', combo: 'Mod+Shift+P' },
    { command: 'paste-properties-no-corners', combo: 'Ctrl+Alt+Mod+V' },
    { command: 'duplicate-behind', combo: 'Mod+Shift+D' },
  )
  if (uiMode === 'sketch' && platform === 'mac' && desktop) bindings.unshift(
    { command: 'zoom-top-level-frame', combo: 'Mod+4' },
    { command: 'align-left', combo: 'Ctrl+Mod+ArrowLeft' },
    { command: 'align-right', combo: 'Ctrl+Mod+ArrowRight' },
    { command: 'align-top', combo: 'Ctrl+Mod+ArrowUp' },
    { command: 'align-bottom', combo: 'Ctrl+Mod+ArrowDown' },
    { command: 'align-horizontal-center', combo: 'Ctrl+Mod+H' },
    { command: 'align-vertical-center', combo: 'Ctrl+Mod+V' },
  )
  if (profile === 'sketch-like') {
    tools.set('set-tool-default', undefined); tools.set('set-tool-pen', 'V'); tools.set('set-tool-pencil', 'P')
    tools.set('set-tool-slice', 'E'); tools.set('set-tool-eraser', undefined); tools.set('set-tool-comments', 'N')
    tools.set('set-tool-eyedropper', platform === 'mac' ? 'Ctrl+C' : 'Shift+I')
    tools.set('set-tool-section', undefined)
    tools.set('set-tool-graphic', 'G')
    if (uiMode === 'sketch') {
      tools.set('set-tool-hotspot', 'I')
      bindings.push({ command: 'auto-pin-selection', combo: 'Shift+A' }, { command: 'auto-pin-contents', combo: 'Alt+Shift+A' })
      bindings.push({ command: 'swap-fills-and-strokes', combo: 'Shift+X' })
      bindings.push({ command: 'toggle-sketch-borders', combo: 'Shift+B' })
      bindings.push({ command: 'toggle-sketch-fills', combo: 'Shift+F' })
      // Native Sketch uses Fn↑/Fn↓, reported as PageUp/PageDown.
      bindings.push({ command: 'previous-page', combo: 'PageUp' }, { command: 'next-page', combo: 'PageDown' })
    }
    bindings.push({ command: 'auto-layout', combo: 'Shift+S' }, { command: 'remove-auto-layout', combo: 'Alt+Shift+S' },
      { command: 'edit-selection', combo: 'Mod+Enter' })
    if (sketchMacSelection) bindings.push(
      { command: 'select-all-force', combo: 'Ctrl+Mod+A' },
      { command: 'select-all-top-level', combo: 'Mod+Shift+A' },
      { command: 'select-matching', combo: 'Mod+Shift+M' },
      { command: 'outline-stroke', combo: 'Mod+Alt+O' },
      { command: 'toggle-pixel-grid', combo: 'Ctrl+X' },
    )
    if (desktop) bindings.unshift({ command: 'fit-frame-content', combo: 'Mod+Shift+F' }, { command: 'new-page', combo: 'Mod+Shift+N' }, { command: 'zoom-100', combo: 'Mod+0' }, { command: 'zoom-fit', combo: 'Mod+1' }, { command: 'zoom-selection', combo: 'Mod+2' }, { command: 'center-selection', combo: 'Mod+3' }, { command: 'frame-selection', combo: 'Mod+F' })
  } else {
    bindings.push(
      { command: 'auto-layout', combo: 'Shift+A' }, { command: 'remove-auto-layout', combo: 'Alt+Shift+A' },
      { command: 'zoom-next-frame', combo: 'N' }, { command: 'zoom-previous-frame', combo: 'Shift+N' },
      { command: 'next-page', combo: 'PageDown' }, { command: 'previous-page', combo: 'PageUp' },
      // Mac desktop Figma: Shift+E toggles Design and Prototype outside vector
      // edit, and the eraser inside vector edit. The outlines view and
      // conversion of strokes have separate shortcuts.
      { command: 'eraser-or-prototype', combo: 'Shift+E' },
      { command: 'outline-stroke', combo: 'Mod+Alt+O' },
      // Mac desktop Figma "Remove stroke" is Shift+/. On a US keyboard that
      // chord reports key "?" and code Slash. Control is not part of it:
      // Control+Shift+? opens the shortcuts panel.
      { command: 'remove-stroke', combo: 'Shift+/' },
      // Figma's shortcut panel lists Layout guides as Shift+G on every
      // documented layout, including US/Generic. The zoom-page Control+G
      // chord is not this binding. Sketch keeps its own Ctrl+L handler.
      { command: 'toggle-layout-guides', combo: 'Shift+G' },
    )
    // Official US QWERTY table: Mac Remove fill is Option+/. Windows is
    // Alt+,. Linux uses the Windows chord. US Option+/ reports "÷".
    // Shift+/ stays Remove stroke on every platform.
    bindings.push(platform === 'mac'
      ? { command: 'remove-fill', combo: 'Alt+/' }
      : { command: 'remove-fill', combo: 'Alt+,', physicalCode: 'Comma' })
    // Figma documents Shift, rather than Alt, for the Windows front/back chord.
    if (platform !== 'mac') for (const binding of bindings) {
      if (binding.command === 'bring-to-front') binding.combo = 'Mod+Shift+]'
      if (binding.command === 'send-to-back') binding.combo = 'Mod+Shift+['
    }
    bindings.unshift({ command: 'bring-to-front', combo: ']' }, { command: 'send-to-back', combo: '[' })
    if (desktop) bindings.push({ command: 'zoom-100', combo: 'Mod+0' })
  }
  // Actual macOS Figma dimension chords share the existing resize commands.
  // Keep Sketch's established non-Mac mapping; no new Figma non-Mac mapping is
  // inferred from the observed macOS keyboard behavior.
  if (profile === 'sketch-like' || platform === 'mac') {
    for (const [key, dimension, direction] of [['ArrowRight', 'width', 'increase'], ['ArrowLeft', 'width', 'decrease'], ['ArrowDown', 'height', 'increase'], ['ArrowUp', 'height', 'decrease']] as const) {
      const command = `resize-${dimension}-${direction}` as const
      bindings.push({ command, combo: `Mod+${key}`, repeat: true },
        { command: `resize-${dimension}-${direction}-large`, combo: `Mod+Shift+${key}`, repeat: true })
      // Mac Sketch Option resizes only the container. Shift uses the large nudge.
      // The chord stays bound when the frame cannot crop, so it does not fall
      // through to a resize that moves the contents.
      if (profile === 'sketch-like' && platform === 'mac') {
        bindings.push(
          { command, combo: `Mod+Alt+${key}`, repeat: true, preserveFrameContents: true },
          { command: `resize-${dimension}-${direction}-large`, combo: `Mod+Shift+Alt+${key}`, repeat: true, preserveFrameContents: true },
        )
      }
    }
  }
  if (desktop) bindings.push({ command: 'ungroup', combo: 'Mod+Backspace' }, { command: 'ungroup', combo: 'Mod+Delete' })
  if (desktop) bindings.unshift({ command: 'rename', combo: 'Mod+R' }, { command: 'paste-to-replace', combo: 'Mod+Shift+R' })
  if (platform !== 'mac') bindings.push({ command: 'redo', combo: 'Mod+Y' })
  bindings.push({ command: 'mask-selection', combo: platform === 'mac' ? 'Mod+Ctrl+M' : 'Mod+Alt+M' })
  if (uiMode !== 'sketch') bindings.push({ command: 'flatten', combo: 'Mod+E' })
  for (const [command, combo] of tools) if (combo) bindings.push({ command: command as EditorCommand, combo })
  if (profile === 'figma-like') bindings.push(
    { command: 'set-tool-frame', combo: 'A' },
    { command: 'keyboard-box-select', combo: platform === 'mac' ? 'Alt+Space' : 'Ctrl+Space', physicalCode: 'Space' },
  )
  // Figma Quick Actions and the Sketch command bar share Mod+K. S is
  // reserved for the Sketch command bar and remains Slice in Figma.
  // The keyboard-layout table also opens Quick Actions with Mod+/ on
  // US/Generic, remapped to Mod+, for German QWERTZ. Mod+K stays.
  bindings.push({ command: 'open-command-search', combo: 'Mod+K' })
  if (profile === 'figma-like') bindings.push({ command: 'open-command-search', combo: 'Mod+/', physicalCode: 'Slash' })
  if (profile === 'sketch-like') bindings.push({ command: 'open-command-search', combo: 'S' })
  // Desktop Figma Find. Browsers keep Mod+F. Sketch desktop Mod+F remains frame-selection.
  if (profile === 'figma-like' && desktop) bindings.push({ command: 'open-layer-find', combo: 'Mod+F' })
  if (profile === 'figma-like' && platform === 'mac') bindings.push({ command: 'set-tool-eyedropper', combo: 'Ctrl+C' })
  if (profile === 'figma-like') bindings.push({ command: 'set-tool-pencil', combo: 'Alt+P' })
  // Figma's layout table uses comma/period for Generic and ß/´ for German.
  // Underline is documented separately and uses the same letter in both.
  if (profile === 'figma-like') {
    const german = keyboardLayout === 'de-qwertz'
    const [less, more] = german ? ['ß', '´'] : [',', '.']
    const [lessCode, moreCode] = german ? ['Minus', 'Equal'] : ['Comma', 'Period']
    const size = german && platform !== 'mac' ? 'Mod' : 'Mod+Shift'
    const tracking = german ? 'Alt' : 'Mod'
    const step = (command: ShortcutAction, combo: string, physicalCode: string): ShortcutBinding => ({ command, combo, physicalCode, repeat: true })
    bindings.push(
      step('decrease-font-size', `${size}+${less}`, lessCode), step('increase-font-size', `${size}+${more}`, moreCode),
      step('decrease-font-weight', `Mod+Alt+${less}`, lessCode), step('increase-font-weight', `Mod+Alt+${more}`, moreCode),
      step('decrease-letter-spacing', `${tracking}+${less}`, lessCode), step('increase-letter-spacing', `${tracking}+${more}`, moreCode),
      step('decrease-line-height', `Shift+Alt+${less}`, lessCode), step('increase-line-height', `Shift+Alt+${more}`, moreCode),
      platform === 'mac'
        ? { command: 'toggle-text-underline', combo: 'Alt+U', physicalCode: 'KeyU' }
        : { command: 'toggle-text-underline', combo: 'Mod+U', physicalCode: 'KeyU' },
      { command: 'text-bullet-list', combo: 'Mod+Shift+8', physicalCode: 'Digit8' },
      { command: 'text-numbered-list', combo: 'Mod+Shift+7', physicalCode: 'Digit7' },
    )
  }
  const result = Object.freeze(bindings.map(binding => Object.freeze(
    profile === 'figma-like' && keyboardLayout === 'de-qwertz' ? germanBinding(binding) : binding,
  )))
  bindingCache.set(cacheKey, result)
  return result
}
function germanBinding(binding: ShortcutBinding): ShortcutBinding {
  const { command, combo } = binding
  if (command === 'select-parent') return { ...binding, combo: '#' }
  if (command === 'toggle-pixel-grid') return { ...binding, combo: 'Mod+#', physicalCode: 'Backslash' }
  if (command === 'toggle-pixel-snapping') return { ...binding, combo: 'Shift+#', physicalCode: 'Backslash' }
  if (command === 'remove-stroke') return { ...binding, combo: 'Shift+,', physicalCode: 'Comma' }
  if (command === 'remove-fill') return { ...binding, combo: 'Alt+,', physicalCode: 'Comma' }
  if (command === 'open-command-search' && combo === 'Mod+/') return { ...binding, combo: 'Mod+,', physicalCode: 'Comma' }
  if (command === 'bring-forward' || command === 'bring-to-front') return { ...binding, combo: combo.replace(']', 'Ä') }
  if (command === 'send-backward' || command === 'send-to-back') return { ...binding, combo: combo.replace('[', 'Ö') }
  return binding
}
/** '+' and 'Mod++' are the plus key. A slash chord such as 'Mod+/' is not. */
function splitShortcutCombo(combo: string): { modifiers: string[]; key: string } {
  if (combo === '+' || combo.endsWith('++')) {
    const head = combo === '+' ? '' : combo.slice(0, -2)
    return { modifiers: head ? head.split('+').filter(Boolean) : [], key: '+' }
  }
  const parts = combo.split('+')
  const key = parts.pop() ?? ''
  return { modifiers: parts.filter(Boolean), key }
}
function matches(event: ShortcutKey, { combo, physicalCode }: ShortcutBinding, platform: ShortcutPlatform) {
  const { modifiers, key } = splitShortcutCombo(combo)
  const mod = modifiers.includes('Mod')
  const meta = modifiers.includes('Meta') || (mod && platform === 'mac')
  const ctrl = modifiers.includes('Ctrl') || (mod && platform !== 'mac')
  const shift = modifiers.includes('Shift'), alt = modifiers.includes('Alt')
  // '+' requires Shift on common layouts, but not on a keypad or all layouts.
  if (event.metaKey !== meta || event.ctrlKey !== ctrl || event.altKey !== alt || (key !== '+' && event.shiftKey !== shift)) return false
  if (shift && ((key === '[' && event.code === 'BracketLeft') || (key === ']' && event.code === 'BracketRight'))) return true
  if (key === '-' && shift && event.code === 'Minus') return true
  if (/^\d$/.test(key) && shift && event.code === `Digit${key}`) return true
  // Shift+/ produces "?" on US keyboards. Match the Slash key, not every "?".
  if (key === '/' && shift && event.code === 'Slash') return true
  if (event.key.toLowerCase() === key.toLowerCase()) return true
  if (physicalCode && event.code === physicalCode && !/^[a-z]$/i.test(event.key)) return true
  // Explicit US/Generic Option outputs only. Preserve logical ASCII keys on
  // other layouts; never guess a base key for unknown symbols or dead keys.
  if (platform === 'mac' && alt && !/^[\x00-\x7f]+$/.test(event.key)) {
    const optionOutputs: Record<string, readonly [string, string, boolean]> = {
      '©': ['G', 'KeyG', false], 'Å': ['A', 'KeyA', true],
      'å': ['A', 'KeyA', false], 'π': ['P', 'KeyP', false],
      'ç': ['C', 'KeyC', false], '√': ['V', 'KeyV', false],
      '“': ['[', 'BracketLeft', false], '‘': [']', 'BracketRight', false],
      '÷': ['/', 'Slash', false],
    }
    const known = optionOutputs[event.key]
    return !!known && key.toUpperCase() === known[0] && event.code === known[1] && event.shiftKey === known[2]
  }
  return false
}
export function resolveShortcut(event: ShortcutKey, context: ShortcutContext): ShortcutBinding | null {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.key === 'Process' || event.getModifierState?.('AltGraph')) return null
  return shortcutBindings(context).find(binding => (event.key !== 'Dead' || binding.physicalCode) && matches(event, binding, context.platform)) || null
}
function normalizedShortcutCommand(command: ShortcutAction): ShortcutAction {
  return command === 'lock-selection' || command === 'unlock-selection' ? 'toggle-lock' : command === 'hide-selection' || command === 'show-selection' ? 'toggle-visibility' : command
}
export function shortcutLabel(command: ShortcutAction, context: ShortcutContext): string | undefined {
  const normalized = normalizedShortcutCommand(command)
  const combo = shortcutBindings(context).find(binding => binding.command === normalized)?.combo
  return combo ? formatShortcutCombo(combo, context.platform) : undefined
}
/** Every distinct label for a command, in binding order. */
export function shortcutLabels(command: ShortcutAction, context: ShortcutContext): string {
  const normalized = normalizedShortcutCommand(command)
  const labels: string[] = []
  for (const binding of shortcutBindings(context)) {
    if (binding.command !== normalized) continue
    const label = formatShortcutCombo(binding.combo, context.platform)
    if (!labels.includes(label)) labels.push(label)
  }
  return labels.join(' / ')
}
/** File/host commands share the same modifier presentation as editor commands. */
export function formatShortcutCombo(combo: string, platform: ShortcutPlatform): string {
  const names: Record<string, string> = platform === 'mac' ? { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Backspace: '⌫' } : { Mod: 'Ctrl', Backspace: 'Backspace' }
  const { modifiers, key } = splitShortcutCombo(combo)
  if (key === '+') {
    const prefix = modifiers.map(part => names[part] || part).join(' + ')
    return prefix ? `${prefix} + +` : '+'
  }
  return [...modifiers, key].map(part => names[part] || part).join(platform === 'mac' ? ' ' : '+')
}
export function toolShortcutLabel(tool: string, context: ShortcutContext): string {
  const command = TOOL_COMMANDS.find(entry => entry.tool === tool)?.id
  if (tool === 'frame') return shortcutBindings(context).filter(binding => binding.command === command)
    .map(binding => formatShortcutCombo(binding.combo, context.platform)).join(' / ')
  return command ? shortcutLabel(command as EditorCommand, context) || '' : ''
}
