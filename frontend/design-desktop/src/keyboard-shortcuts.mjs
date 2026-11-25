/** Electron input boundary only. The renderer owns profile/tool commands and
 * focused-control/modal checks. No Electron import is needed for policy tests. */
export function nativeSettingsAccelerator(interfaceMode, figmaKeyboardLayout) {
  return interfaceMode === 'figma' && figmaKeyboardLayout === 'de-qwertz' ? undefined : 'CmdOrCtrl+,'
}

export function nativeShortcutRoute(input, platform, interfaceMode = 'figma', figmaKeyboardLayout = 'us-qwerty') {
  const key = String(input.key || '').toLowerCase()
  const composing = input.isComposing || input.keyCode === 229 || key === 'dead' || key === 'process'
  if (composing) return { suppressMenu: true, consume: false }
  const mod = platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta
  if (!mod) return { suppressMenu: false, consume: false }
  // Electron does not expose AltGraph here. Let renderer getModifierState make
  // that distinction on Windows/Linux, without a native accelerator racing it.
  if (platform !== 'darwin' && input.alt) return { suppressMenu: true, consume: false }
  // German Figma assigns this chord to the renderer's Quick actions route.
  if (!input.alt && !input.shift && key === ',' && !nativeSettingsAccelerator(interfaceMode, figmaKeyboardLayout))
    return { suppressMenu: true, consume: false }
  const zoom = !input.alt && ['=', '+', '-'].includes(key) && (!input.shift || key === '+')
  const suppressMenu = !!input.isAutoRepeat && !zoom
  if (input.type !== 'keyDown') return { suppressMenu, consume: false }
  let command
  if (input.alt) {
    if (!input.shift) command = { KeyC: 'copy-properties', KeyV: 'paste-properties',
      KeyA: interfaceMode === 'sketch' ? undefined : 'select-matching' }[input.code]
  } else if (zoom) command = key === '-' ? 'zoomOut' : 'zoomIn'
  else if (input.shift) command = { z: 'redo', c: 'copy-as-png', r: 'paste-to-replace', v: 'paste-over-selection', a: 'select-inverse', g: 'ungroup' }[key]
  else command = { ',': 'settings', '0': 'zoom100', z: 'undo', c: 'copy', x: 'cut', v: 'paste', a: 'select-all', d: 'duplicate', g: 'group' }[key]
  return { suppressMenu, consume: !!command, command: suppressMenu ? undefined : command }
}
export function forwardNativeEditorShortcut(event, input, { platform, interfaceMode, figmaKeyboardLayout, sendCommand, setIgnoreMenuShortcuts }) {
  const route = nativeShortcutRoute(input, platform, interfaceMode, figmaKeyboardLayout)
  setIgnoreMenuShortcuts(route.suppressMenu)
  if (route.consume) event.preventDefault()
  if (route.command) sendCommand(route.command)
  return route.consume
}
