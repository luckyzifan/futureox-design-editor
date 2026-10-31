import { useInterfaceText } from './interface-preference'
import { useId, useState } from 'react'
import { desktopBridge } from './desktop'
import { shortcutLabel, shortcutPlatform, toolShortcutLabel, type ShortcutProfile } from './shortcut-profiles'
import { shortcutPreference, useShortcutProfile } from './shortcut-preference'
export function KeyboardProfileSettings() {
  const text = useInterfaceText()
  const profile = useShortcutProfile(), id = useId(), [temporary, setTemporary] = useState(false)
  const context = { profile, platform: shortcutPlatform(), desktop: !!desktopBridge() }
  return <section className="keyboard-profile-settings" aria-label={text.keyboardSettings}>
    <label htmlFor={id}>{text.shortcutProfile}</label>
    <select id={id} aria-describedby={`${id}-help`} value={profile} onChange={event => setTemporary(!shortcutPreference.set(event.target.value as ShortcutProfile))}>
      <option value="figma-like">Figma-like</option><option value="sketch-like">Sketch-like</option>
    </select>
    <small id={`${id}-help`}>{text.shortcutHelp}</small>
    <small>{text.pen} {toolShortcutLabel('pen', context)} · {text.pencil} {toolShortcutLabel('pencil', context)} · {text.slice} {toolShortcutLabel('slice', context)} · {text.fitAll} {shortcutLabel('zoom-fit', context)} · {text.rename} {shortcutLabel('rename', context)}</small>
    {temporary && <small role="status">{text.shortcutTemporary}</small>}
  </section>
}
