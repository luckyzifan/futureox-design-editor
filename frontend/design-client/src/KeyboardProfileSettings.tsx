import { useId, useState } from 'react'
import { desktopBridge } from './desktop'
import { shortcutLabel, shortcutPlatform, toolShortcutLabel, type ShortcutProfile } from './shortcut-profiles'
import { shortcutPreference, useShortcutProfile } from './shortcut-preference'
export function KeyboardProfileSettings() {
  const profile = useShortcutProfile(), id = useId(), [temporary, setTemporary] = useState(false)
  const context = { profile, platform: shortcutPlatform(), desktop: !!desktopBridge() }
  return <section className="keyboard-profile-settings" aria-label="键盘快捷键设置">
    <label htmlFor={id}>快捷键方案</label>
    <select id={id} aria-describedby={`${id}-help`} value={profile} onChange={event => setTemporary(!shortcutPreference.set(event.target.value as ShortcutProfile))}>
      <option value="figma-like">Figma-like</option><option value="sketch-like">Sketch-like</option>
    </select>
    <small id={`${id}-help`}>常用快捷键预设，只影响本机；非完整兼容。Windows / Linux 使用 Ctrl。浏览器保留刷新、查找和切换标签页快捷键。</small>
    <small>钢笔 {toolShortcutLabel('pen', context)} · 铅笔 {toolShortcutLabel('pencil', context)} · 切片 {toolShortcutLabel('slice', context)} · 适合全部 {shortcutLabel('zoom-fit', context)} · 重命名 {shortcutLabel('rename', context)}</small>
    {temporary && <small role="status">当前存储不可用；方案仅在本次会话生效。</small>}
  </section>
}
