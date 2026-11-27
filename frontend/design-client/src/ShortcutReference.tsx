import { useId, useMemo, useState, useSyncExternalStore } from 'react'
import { X } from 'lucide-react'
import { commandTitleForShortcuts } from './command-search'
import { desktopBridge } from './desktop'
import { interfacePreference, useInterfacePreferences, type FigmaKeyboardLayout, type InterfaceLocale } from './interface-preference'
import { formatShortcutCombo, shortcutBindings, shortcutPlatform, type ShortcutAction, type ShortcutBinding } from './shortcut-profiles'
import { closeShortcutReference, shortcutReferenceOpen, shortcutUseKey, subscribeShortcutReference, subscribeUsedShortcuts, usedShortcutSnapshot } from './shortcut-reference-session'
import { localizedToolCommands } from './tool-registry'

const tabs = ['tools', 'edit', 'view', 'layout'] as const
type Tab = typeof tabs[number]
const copy = {
  'zh-CN': { title: '键盘快捷键', close: '关闭快捷键一览', tools: '工具', edit: '编辑与选区', view: '视图', layout: '布局', keyboard: '键盘布局', used: '已使用' },
  en: { title: 'Keyboard shortcuts', close: 'Close keyboard shortcuts', tools: 'Tools', edit: 'Edit and selection', view: 'View', layout: 'Layout', keyboard: 'Keyboard layout', used: 'Used' },
} as const
const titles: Partial<Record<ShortcutAction, readonly [string, string]>> = {
  'open-shortcut-reference': ['键盘快捷键', 'Keyboard shortcuts'],
  'open-command-search': ['快速操作', 'Quick actions'],
  'open-quick-insert': ['快速插入组件', 'Quick insert'],
  'open-layer-find': ['搜索图层', 'Find layers'],
  'toggle-layout-guides': ['布局参考线', 'Layout guides'],
  'toggle-pixel-grid': ['像素网格', 'Pixel grid'],
  'toggle-pixel-snapping': ['吸附到像素网格', 'Snap to pixel grid'],
  'toggle-outlines': ['显示轮廓', 'Show outlines'],
  'toggle-lock': ['锁定或解锁选区', 'Lock or unlock selection'],
  'toggle-visibility': ['显示或隐藏选区', 'Show or hide selection'],
  'opacity-digit': ['用数字键设置不透明度', 'Set opacity with number keys'],
  'select-parent': ['选择父图层', 'Select parent'],
  'keyboard-box-select': ['键盘框选', 'Keyboard box selection'],
  'remove-fill': ['去掉填充', 'Remove fill'],
  'remove-stroke': ['去掉描边', 'Remove stroke'],
}
function group(command: string): Exclude<Tab, 'layout'> {
  if (command.startsWith('set-tool-')) return 'tools'
  if (command.startsWith('zoom-') || command.startsWith('open-') || command.startsWith('toggle-pixel-') ||
      ['toggle-layout-guides', 'toggle-outlines', 'next-page', 'previous-page', 'eraser-or-prototype'].includes(command)) return 'view'
  return 'edit'
}
function title(command: ShortcutAction, locale: InterfaceLocale, tools: ReadonlyMap<string, string>) {
  if (titles[command]) return titles[command]![locale === 'en' ? 1 : 0]
  if (command.startsWith('resize-')) {
    const [, axis, direction, large] = command.split('-')
    if (locale === 'en') return `${direction === 'increase' ? 'Increase' : 'Decrease'} ${axis}${large ? ' (large step)' : ''}`
    return `${direction === 'increase' ? '增加' : '减小'}${axis === 'width' ? '宽度' : '高度'}${large ? '（大步长）' : ''}`
  }
  return tools.get(command) ?? commandTitleForShortcuts(command, locale) ?? command.replaceAll('-', ' ')
}

export function ShortcutReference() {
  const open = useSyncExternalStore(subscribeShortcutReference, shortcutReferenceOpen, () => false)
  return open ? <ShortcutDock /> : null
}

function ShortcutDock() {
  const { locale, figmaKeyboardLayout } = useInterfacePreferences()
  const used = useSyncExternalStore(subscribeUsedShortcuts, usedShortcutSnapshot)
  const [tab, setTab] = useState<Tab>('tools')
  const id = useId(), text = copy[locale], platform = shortcutPlatform()
  const tools = useMemo(() => {
    const map = new Map<string, string>()
    for (const tool of localizedToolCommands(locale)) if (!map.has(tool.id)) map.set(tool.id, tool.label)
    return map
  }, [locale])
  const bindings = shortcutBindings({ profile: 'figma-like', uiMode: 'figma', platform,
    desktop: !!desktopBridge(), keyboardLayout: figmaKeyboardLayout })
  const rows = useMemo(() => {
    const result = new Map<ShortcutAction, ShortcutBinding[]>()
    for (const binding of bindings) {
      if (group(binding.command) !== tab) continue
      const keys = result.get(binding.command) ?? []
      if (!keys.some(key => key.combo === binding.combo)) keys.push(binding)
      result.set(binding.command, keys)
    }
    return [...result]
  }, [bindings, tab])

  return <section className="shortcut-reference" aria-label={text.title} onKeyDown={event => {
    event.stopPropagation()
    if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (!event.repeat) closeShortcutReference()
  }}>
    <header><strong>{text.title}</strong><button type="button" aria-label={text.close} onClick={() => closeShortcutReference()}>
      <X size={16} />
    </button></header>
    <div role="tablist" aria-label={text.title} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1)! :
        tabs[(tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]
      setTab(next)
      document.getElementById(`${id}-${next}`)?.focus()
    }}>
      {tabs.map(value => <button key={value} type="button" role="tab" id={`${id}-${value}`} tabIndex={tab === value ? 0 : -1}
        aria-controls={`${id}-panel`} aria-selected={tab === value} onClick={() => setTab(value)}>{text[value]}</button>)}
    </div>
    <div className="shortcut-reference-content" id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}`}>
      {tab === 'layout' ? <label>{text.keyboard}<select value={figmaKeyboardLayout}
        onChange={event => interfacePreference.set({ figmaKeyboardLayout: event.currentTarget.value as FigmaKeyboardLayout })}>
        <option value="us-qwerty">US QWERTY</option>
        <option value="de-qwertz">Deutsch (QWERTZ)</option>
      </select></label> : <dl>
        {rows.map(([command, keys]) => <div key={command} data-shortcut-command={command}>
          <dt>{title(command, locale, tools)}</dt>
          <dd>{keys.map(binding => {
            const label = formatShortcutCombo(binding.combo, platform), seen = used.has(shortcutUseKey(binding))
            return <kbd key={binding.combo} data-used={seen} aria-label={seen ? `${label}, ${text.used}` : label}>{label}</kbd>
          })}</dd>
        </div>)}
      </dl>}
    </div>
  </section>
}
