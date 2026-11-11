import { alignSelection } from './alignment-availability'
import { canvasCommandEnglish, canvasCommandLabel, canvasText } from './canvas-interface-messages'
import { canvasMenuItems, lockedSelectionIds } from './canvas-menu-model'
import { SelectionCommandError, selectionCommandAdmission } from './commands/selection-command'
import { prepareLayoutRemove } from './commands/layout-command'
import { ActionSource } from './canvas-action-diagnostics'
import { dispatchEditorCommand, type EditorCommand } from './editor-commands'
import type { Editor } from './engine'
import { userPages } from './fig-document'
import type { InterfaceLocale } from './interface-preference'
import { container } from './model'
import { commitPendingEdits } from './pending-edits'
import { formatShortcutCombo, shortcutBindings, type ShortcutContext } from './shortcut-profiles'
import { localizedToolCommands, unavailableReason } from './tool-registry'

/** Presentation only. Running a row always goes through the existing command routes. */
export const commandSearchText = {
  'zh-CN': {
    title: '运行…', label: '运行命令', search: '搜索命令', placeholder: '搜索命令…',
    empty: '没有匹配的命令', close: '关闭命令搜索', unavailable: '当前不能运行',
  },
  en: {
    title: 'Run…', label: 'Run commands', search: 'Search for commands', placeholder: 'Search for commands…',
    empty: 'No matching commands', close: 'Close command search', unavailable: 'This command cannot run',
  },
} as const

export type CommandSearchAction =
  | { kind: 'command'; command: EditorCommand }
  | { kind: 'align'; axis: 'x' | 'y'; mode: 'start' | 'center' | 'end' | 'distribute' }
  | { kind: 'geometry'; operation: 'union' | 'subtract' | 'intersect' | 'exclude' | 'divide' }

export type CommandSearchEntry = {
  id: string
  label: string
  aliases: readonly string[]
  shortcut?: string
  combo?: string
  group: string
  disabled: boolean
  reason?: string
  action: CommandSearchAction
  order: number
}

type Spec = { command: EditorCommand; zh: string; en: string; group: string; aliases?: readonly string[] }

const catalog: readonly Spec[] = [
  { command: 'undo', zh: '撤销', en: 'Undo', group: 'history' },
  { command: 'redo', zh: '重做', en: 'Redo', group: 'history' },
  { command: 'copy', zh: '复制', en: 'Copy', group: 'clipboard' },
  { command: 'cut', zh: '剪切', en: 'Cut', group: 'clipboard' },
  { command: 'paste', zh: '粘贴', en: 'Paste', group: 'clipboard' },
  { command: 'paste-here', zh: '粘贴到此处', en: 'Paste here', group: 'clipboard' },
  { command: 'paste-in-place', zh: '粘贴到原位', en: 'Paste in place', group: 'clipboard' },
  { command: 'paste-to-replace', zh: '粘贴替换', en: 'Paste to replace', group: 'clipboard' },
  { command: 'paste-over-selection', zh: '覆盖粘贴（保留目标）', en: 'Paste over selection (keep targets)', group: 'clipboard' },
  { command: 'duplicate', zh: '创建副本', en: 'Duplicate', group: 'clipboard', aliases: ['duplicate', '副本'] },
  { command: 'delete', zh: '删除', en: 'Delete', group: 'clipboard' },
  { command: 'copy-properties', zh: '复制属性', en: 'Copy properties', group: 'clipboard' },
  { command: 'paste-properties', zh: '粘贴属性', en: 'Paste properties', group: 'clipboard' },
  { command: 'copy-fills', zh: '复制填充', en: 'Copy fills', group: 'clipboard' },
  { command: 'copy-strokes', zh: '复制描边', en: 'Copy strokes', group: 'clipboard' },
  { command: 'copy-effects', zh: '复制效果', en: 'Copy effects', group: 'clipboard' },
  { command: 'copy-as-png', zh: '复制为 PNG', en: 'Copy as PNG', group: 'clipboard' },
  { command: 'copy-as-svg', zh: '复制为 SVG', en: 'Copy as SVG', group: 'clipboard' },
  { command: 'bring-to-front', zh: '置于顶层', en: 'Bring to front', group: 'order' },
  { command: 'bring-forward', zh: '向上一层', en: 'Bring forward', group: 'order' },
  { command: 'send-backward', zh: '向下一层', en: 'Send backward', group: 'order' },
  { command: 'send-to-back', zh: '置于底层', en: 'Send to back', group: 'order' },
  { command: 'group', zh: '编组', en: 'Group selection', group: 'structure', aliases: ['group'] },
  { command: 'frame-selection', zh: '创建选区画板', en: 'Frame selection', group: 'structure' },
  { command: 'ungroup', zh: '解除编组', en: 'Ungroup', group: 'structure' },
  { command: 'flatten', zh: '展平', en: 'Flatten', group: 'structure' },
  { command: 'auto-layout', zh: '添加自动布局', en: 'Add auto layout', group: 'layout' },
  { command: 'remove-auto-layout', zh: '移除自动布局', en: 'Remove auto layout', group: 'layout' },
  { command: 'create-component', zh: '创建组件', en: 'Create component', group: 'component' },
  { command: 'detach-instance', zh: '分离实例', en: 'Detach instance', group: 'component' },
  { command: 'lock-selection', zh: '锁定图层', en: 'Lock layers', group: 'visibility' },
  { command: 'unlock-selection', zh: '解锁图层', en: 'Unlock layers', group: 'visibility' },
  { command: 'hide-selection', zh: '隐藏图层', en: 'Hide layers', group: 'visibility' },
  { command: 'show-selection', zh: '显示图层', en: 'Show layers', group: 'visibility' },
  { command: 'flip-horizontal', zh: '水平翻转', en: 'Flip horizontal', group: 'transform' },
  { command: 'flip-vertical', zh: '垂直翻转', en: 'Flip vertical', group: 'transform' },
  { command: 'convert-vector', zh: '转换为矢量', en: 'Convert to vector', group: 'geometry' },
  { command: 'outline-stroke', zh: '轮廓化描边', en: 'Outline stroke', group: 'geometry' },
  { command: 'mask-selection', zh: '用作蒙版', en: 'Use as mask', group: 'geometry' },
  { command: 'rename', zh: '重命名', en: 'Rename', group: 'naming' },
  { command: 'convert-section', zh: '转换为分区', en: 'Convert to section', group: 'naming' },
  { command: 'select-matching', zh: '选择匹配图层', en: 'Select matching layers', group: 'selection' },
  { command: 'select-properties', zh: '选择相同属性', en: 'Select same properties', group: 'selection' },
  { command: 'select-fill', zh: '选择相同填充', en: 'Select same fill', group: 'selection' },
  { command: 'select-stroke', zh: '选择相同描边', en: 'Select same stroke', group: 'selection' },
  { command: 'select-effect', zh: '选择相同效果', en: 'Select same effects', group: 'selection' },
  { command: 'select-text', zh: '选择相同文字属性', en: 'Select same text properties', group: 'selection' },
  { command: 'select-font', zh: '选择相同字体', en: 'Select same font', group: 'selection' },
  { command: 'select-instance', zh: '选择同一组件实例', en: 'Select instances of the same component', group: 'selection' },
  { command: 'select-inverse', zh: '反选', en: 'Invert selection', group: 'selection' },
  { command: 'select-all', zh: '全选', en: 'Select all', group: 'selection' },
  { command: 'zoom-in', zh: '放大', en: 'Zoom in', group: 'view' },
  { command: 'zoom-out', zh: '缩小', en: 'Zoom out', group: 'view' },
  { command: 'zoom-100', zh: '缩放至 100%', en: 'Zoom to 100%', group: 'view', aliases: ['100%'] },
  { command: 'zoom-fit', zh: '缩放至全部内容', en: 'Zoom to all content', group: 'view' },
  { command: 'zoom-selection', zh: '缩放至选区', en: 'Zoom to selection', group: 'view' },
  { command: 'center-selection', zh: '居中选区（保留缩放）', en: 'Center selection (keep zoom)', group: 'view' },
  { command: 'zoom-next-frame', zh: '缩放到下一画板', en: 'Zoom to next frame', group: 'view' },
  { command: 'zoom-previous-frame', zh: '缩放到上一画板', en: 'Zoom to previous frame', group: 'view' },
  { command: 'next-page', zh: '下一页', en: 'Next page', group: 'view' },
  { command: 'previous-page', zh: '上一页', en: 'Previous page', group: 'view' },
  { command: 'new-page', zh: '新建页面', en: 'New page', group: 'view' },
  { command: 'eraser-or-prototype', zh: '切换橡皮或原型', en: 'Toggle eraser or prototype', group: 'view', aliases: ['原型', 'prototype', '橡皮', 'eraser'] },
]

const arrangeSpec = [
  ['align-x-start', 'x', 'start', 'alignLeft'],
  ['align-x-center', 'x', 'center', 'alignCenter'],
  ['align-x-end', 'x', 'end', 'alignRight'],
  ['align-y-start', 'y', 'start', 'alignTop'],
  ['align-y-center', 'y', 'center', 'alignMiddle'],
  ['align-y-end', 'y', 'end', 'alignBottom'],
  ['distribute-x', 'x', 'distribute', 'distributeHorizontal'],
  ['distribute-y', 'y', 'distribute', 'distributeVertical'],
] as const

const geometrySpec = [
  ['geometry-union', 'union', 'union'],
  ['geometry-subtract', 'subtract', 'subtract'],
  ['geometry-intersect', 'intersect', 'intersect'],
  ['geometry-exclude', 'exclude', 'exclude'],
  ['geometry-divide', 'divide', 'divideLegacy'],
] as const

function phrase(locale: InterfaceLocale, zh: string, en: string) {
  return locale === 'en' ? en : zh
}

function fold(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function presentedShortcut(command: string, context: ShortcutContext) {
  const normalized = command === 'lock-selection' || command === 'unlock-selection' ? 'toggle-lock'
    : command === 'hide-selection' || command === 'show-selection' ? 'toggle-visibility' : command
  const binding = shortcutBindings(context).find(item => item.command === normalized)
  return binding ? { shortcut: formatShortcutCombo(binding.combo, context.platform), combo: binding.combo } : {}
}

function forms(spec: Spec, locale: InterfaceLocale, multiple: boolean, lockedParent: boolean) {
  const zh = spec.command === 'rename' && multiple ? '批量重命名…'
    : spec.command === 'unlock-selection' && lockedParent ? '解锁图层及父级' : spec.zh
  const known = spec.command in canvasCommandEnglish || spec.command === 'rename' || spec.command === 'unlock-selection'
  const label = known ? canvasCommandLabel(spec.command, zh, locale, multiple, lockedParent) : phrase(locale, zh, spec.en)
  const aliases = new Set<string>([spec.zh, spec.en, zh, canvasCommandEnglish[spec.command] ?? spec.en, ...(spec.aliases ?? [])])
  if (spec.command === 'rename') ['重命名', '批量重命名…', 'Rename', 'Batch rename…'].forEach(item => aliases.add(item))
  if (spec.command === 'unlock-selection') ['解锁图层', '解锁图层及父级', 'Unlock layers', 'Unlock layers and ancestors'].forEach(item => aliases.add(item))
  aliases.delete(label)
  return { label, aliases: [...aliases] }
}

/** Shared admission text for rows the current menu hides or disables. */
function explain(editor: Editor, action: CommandSearchAction, context: ShortcutContext, locale: InterfaceLocale): string | undefined {
  const block = editor.state.busy ? phrase(locale, '正在处理其他操作', 'Another operation is still running')
    : editor.interactionActive ? phrase(locale, '请先结束拖动，或按 Esc 取消', 'Finish the drag or press Esc') : undefined
  if (block) return block
  const doc = editor.state.doc
  const nodes = editor.state.selection.map(id => doc.nodes[id]).filter(Boolean)
  const page = doc.pages.find(item => item.id === editor.state.page)
  const none = phrase(locale, '没有选中图层', 'Select at least one node')
  const locked = phrase(locale, '选区或父级已锁定', 'Selection or an affected ancestor/child is locked')
  const mutable = () => !nodes.length ? none : lockedSelectionIds(editor).length ? locked : undefined
  const sameParent = () => {
    const ids = editor.topSelection()
    if (ids.length < 2) return undefined
    const parents = editor.parentMap()
    const parent = parents.get(ids[0])
    return ids.some(id => parents.get(id) !== parent) ? phrase(locale, '选中的图层不在同一父级', 'Grouping requires the same immediate parent') : undefined
  }
  if (action.kind === 'align') {
    const kind = action.mode === 'distribute' ? 'distribute' : 'align'
    const result = selectionCommandAdmission(doc, editor.state.selection, kind, editor.parentMap())
    return result.ok ? undefined : result.message
  }
  if (action.kind === 'geometry') {
    if (editor.state.selection.length < 2) return phrase(locale, '至少选择两个图层', 'Select at least two layers')
    const owned = mutable()
    if (owned) return owned
    if (action.operation === 'divide') {
      if (nodes.some(node => container(node) || node.kind === 'text')) return '请选择形状或矢量图层'
      const parents = editor.parentMap(), ids = editor.topSelection(), parent = parents.get(ids[0])
      if (ids.some(id => parents.get(id) !== parent)) return '几何运算需要选择同一容器内的图层'
      return undefined
    }
    const wrap = selectionCommandAdmission(doc, editor.state.selection, 'wrap', editor.parentMap())
    return wrap.ok ? undefined : wrap.message
  }
  const command = action.command
  if (command.startsWith('set-tool-')) return unavailableReason(command, locale) ?? undefined
  if (command === 'undo') return editor.canUndo ? undefined : phrase(locale, '没有可撤销的操作', 'Nothing to undo')
  if (command === 'redo') return editor.canRedo ? undefined : phrase(locale, '没有可重做的操作', 'Nothing to redo')
  if (command === 'zoom-in' || command === 'zoom-out' || command === 'zoom-100' || command === 'paste' || command === 'paste-in-place' || command === 'new-page' || command === 'eraser-or-prototype') return undefined
  if (command === 'select-all' || command === 'zoom-fit') return page?.children.length ? undefined : phrase(locale, '当前页面没有图层', 'This page has no layers')
  if (command === 'zoom-next-frame' || command === 'zoom-previous-frame') {
    const hasFrame = !!page?.children.some(id => {
      const node = doc.nodes[id]
      return !!node?.visible && (node.kind === 'frame' || node.kind === 'section')
    })
    return hasFrame ? undefined : phrase(locale, '当前页面没有画板', 'This page has no frames')
  }
  if (command === 'next-page' || command === 'previous-page') {
    const pages = userPages(doc)
    const index = pages.findIndex(item => item.id === editor.state.page)
    if (command === 'next-page' && (index < 0 || index >= pages.length - 1)) return phrase(locale, '已经是最后一页', 'Already on the last page')
    if (command === 'previous-page' && index <= 0) return phrase(locale, '已经是第一页', 'Already on the first page')
    return undefined
  }
  if (command === 'copy' || command === 'copy-as-png' || command === 'copy-as-svg') return nodes.length ? undefined : none
  if (command === 'copy-properties' || command === 'copy-fills' || command === 'copy-strokes' || command === 'copy-effects')
    return nodes.length === 1 ? undefined : phrase(locale, '请选择一个来源图层', 'Select one source layer')
  if (command.startsWith('select-')) return nodes.length ? undefined : none
  if (command === 'zoom-selection' || command === 'center-selection') return nodes.length ? undefined : none
  if (command === 'lock-selection' || command === 'unlock-selection' || command === 'hide-selection' || command === 'show-selection') {
    if (!nodes.length) return none
    const hasLock = lockedSelectionIds(editor).length > 0
    if (command === 'lock-selection') return hasLock ? phrase(locale, '选中的图层已经锁定', 'The selection is already locked') : undefined
    if (command === 'unlock-selection') return hasLock ? undefined : phrase(locale, '选中的图层没有锁定', 'The selection is not locked')
    if (command === 'hide-selection') return nodes.every(node => node.visible) ? undefined : phrase(locale, '选中的图层已经隐藏', 'Some or all selected layers are hidden')
    return nodes.every(node => node.visible) ? phrase(locale, '选中的图层已经显示', 'The selection is already visible') : undefined
  }
  if (command === 'rename') {
    if (!nodes.length) return none
    if (nodes.length > 1 && (lockedSelectionIds(editor).length || nodes.some(node => node.instanceOrigin)))
      return phrase(locale, '当前选择不能批量重命名', 'This selection cannot be batch renamed')
    return undefined
  }
  if (command === 'remove-auto-layout') {
    const owned = mutable()
    if (owned) return owned
    if (!(nodes.length === 1 && nodes[0].layout?.mode && nodes[0].layout.mode !== 'none'))
      return phrase(locale, '选中的图层没有自动布局', 'The selection has no auto layout')
    try { prepareLayoutRemove(doc, editor.state.selection, { fresh: true }); return undefined }
    catch (error) { if (error instanceof SelectionCommandError) return error.message; throw error }
  }
  if (command === 'flatten') {
    const owned = mutable()
    if (owned) return owned
    if (nodes.some(node => node.kind === 'text' || node.kind === 'slice' || node.instance || node.component || node.componentSet))
      return '文字、切片和组件不能展平'
    return undefined
  }
  if (command === 'outline-stroke') {
    const owned = mutable()
    if (owned) return owned
    if (nodes.some(node => container(node) || node.kind === 'text' || node.kind === 'slice')) return '请选择形状或矢量图层'
    if (!nodes.some(node => node.strokes.some(stroke => stroke.visible && stroke.width > 0))) return '所选图层没有可轮廓化的描边'
    return sameParent()
  }
  if (command === 'convert-vector') {
    const owned = mutable()
    if (owned) return owned
    if (!nodes.length || nodes.some(node => container(node) || node.kind === 'text')) return '请选择形状或矢量图层'
    if (nodes.every(node => node.kind === 'vector')) return phrase(locale, '已经是矢量', 'Already a vector')
    return undefined
  }
  if (command === 'convert-section') {
    const owned = mutable()
    if (owned) return owned
    if (!nodes.length || nodes.some(node => node.kind !== 'frame' || node.component || node.instance || node.componentSet))
      return phrase(locale, '请选择未设为组件的画板', 'Select frames that are not components')
    return undefined
  }
  if (command === 'detach-instance') {
    const owned = mutable()
    if (owned) return owned
    if (nodes.length !== 1 || !nodes[0].instance) return phrase(locale, '请选择一个组件实例', 'Select one component instance')
    return undefined
  }
  if (command === 'paste-over-selection') {
    const owned = mutable()
    if (owned) return owned
    if (context.profile === 'figma-like' && editor.topSelection().length !== 1)
      return phrase(locale, '此快捷键方案的覆盖粘贴需要一个目标', 'Paste over selection needs one target in this shortcut profile')
    return undefined
  }
  if (command === 'mask-selection') return mutable() ?? sameParent() ?? (editor.topSelection().length < 2 ? 'Mask grouping requires at least two nodes' : undefined)
  if (command === 'ungroup') {
    const owned = mutable()
    if (owned) return owned
    const result = selectionCommandAdmission(doc, editor.state.selection, 'unwrap', editor.parentMap())
    return result.ok ? undefined : result.message
  }
  if (command === 'group' || command === 'frame-selection' || command === 'create-component' || command === 'auto-layout'
    || command === 'cut' || command === 'delete' || command === 'duplicate' || command === 'paste-to-replace' || command === 'paste-properties'
    || command === 'bring-to-front' || command === 'bring-forward' || command === 'send-backward' || command === 'send-to-back'
    || command === 'flip-horizontal' || command === 'flip-vertical') {
    if (command === 'group' || command === 'frame-selection' || command === 'create-component' || command === 'auto-layout') return mutable() ?? sameParent()
    return mutable()
  }
  return undefined
}

function availability(editor: Editor, action: CommandSearchAction, context: ShortcutContext, locale: InterfaceLocale, menuDisabled: boolean | undefined) {
  if (action.kind === 'command' && action.command === 'paste-here')
    return { disabled: true, reason: phrase(locale, '粘贴位置无效', 'Paste here needs a point on the canvas') }
  if (menuDisabled === false) return { disabled: false }
  const reason = explain(editor, action, context, locale)
  if (menuDisabled === true) return { disabled: true, reason: reason ?? commandSearchText[locale].unavailable }
  return reason ? { disabled: true, reason } : { disabled: false }
}

/** Every row is an existing editor, alignment, or geometry command. Search text is not stored. */
export function commandSearchEntries(editor: Editor, context: ShortcutContext, locale: InterfaceLocale): CommandSearchEntry[] {
  const menu = new Map(canvasMenuItems(editor, context).map(item => [item.command, item]))
  const multiple = editor.state.selection.length > 1
  const lockedParent = lockedSelectionIds(editor).some(id => !editor.state.selection.includes(id))
  const entries: CommandSearchEntry[] = []
  const push = (entry: Omit<CommandSearchEntry, 'order' | 'disabled' | 'reason'> & { action: CommandSearchAction; menuDisabled?: boolean }) => {
    const state = availability(editor, entry.action, context, locale, entry.menuDisabled)
    entries.push({ ...entry, ...state, order: entries.length })
  }
  for (const spec of catalog) {
    const presented = forms(spec, locale, multiple, lockedParent)
    const keys = presentedShortcut(spec.command, context)
    push({
      id: spec.command, label: presented.label, aliases: presented.aliases, group: spec.group, ...keys,
      action: { kind: 'command', command: spec.command }, menuDisabled: menu.get(spec.command)?.disabled,
    })
  }
  const seen = new Set<string>()
  const tools = localizedToolCommands(locale)
  const otherTools = localizedToolCommands(locale === 'en' ? 'zh-CN' : 'en')
  for (const tool of tools) {
    if (seen.has(tool.id)) continue
    seen.add(tool.id)
    const other = otherTools.find(item => item.id === tool.id)?.label
    const keys = presentedShortcut(tool.id, context)
    push({
      id: tool.id, label: tool.label, aliases: other && other !== tool.label ? [other] : [], group: 'tools', ...keys,
      action: { kind: 'command', command: tool.id as EditorCommand },
    })
  }
  const alignText = canvasText[locale], otherAlign = canvasText[locale === 'en' ? 'zh-CN' : 'en']
  for (const [id, axis, mode, key] of arrangeSpec) {
    push({
      id, label: alignText[key], aliases: otherAlign[key] === alignText[key] ? [] : [otherAlign[key]], group: 'arrange',
      action: { kind: 'align', axis, mode },
    })
  }
  for (const [id, operation, key] of geometrySpec) {
    push({
      id, label: alignText[key], aliases: otherAlign[key] === alignText[key] ? [] : [otherAlign[key]], group: 'geometry',
      action: { kind: 'geometry', operation },
    })
  }
  return entries
}

export function filterCommandSearch(entries: readonly CommandSearchEntry[], query: string): CommandSearchEntry[] {
  const normalized = fold(query)
  if (!normalized) return [...entries]
  const tokens = normalized.split(' ').filter(Boolean)
  const compact = normalized.replace(/ /g, '')
  const ranked: { entry: CommandSearchEntry; rank: number }[] = []
  for (const entry of entries) {
    const label = fold(entry.label)
    const aliases = entry.aliases.map(fold)
    const shortcut = fold(entry.shortcut ?? '').replace(/ /g, '')
    const combo = fold(entry.combo ?? '').replace(/ /g, '')
    const shortcutHit = !!compact && (compact === shortcut || compact === combo)
    const tokenHit = tokens.every(token => label.includes(token) || aliases.some(alias => alias.includes(token)))
    if (!shortcutHit && !tokenHit) continue
    const rank = label.startsWith(normalized) ? 0 : label.includes(normalized) ? 1 : aliases.some(alias => alias.startsWith(normalized)) ? 2 : 3
    ranked.push({ entry, rank })
  }
  ranked.sort((a, b) => a.rank - b.rank || a.entry.order - b.entry.order)
  return ranked.map(item => item.entry)
}

/** Executes one admitted row. Disabled rows and failed pending drafts do not publish a search step. */
export async function runCommandSearch(editor: Editor, entry: CommandSearchEntry, context: ShortcutContext): Promise<void> {
  if (entry.disabled) return
  if (entry.action.kind === 'command') {
    await dispatchEditorCommand(editor, entry.action.command, { shortcutProfile: context.profile, actionSource: ActionSource.menu })
    return
  }
  if (entry.action.kind === 'align') {
    alignSelection(editor, entry.action.axis, entry.action.mode)
    return
  }
  if (!commitPendingEdits(editor)) return
  await editor.geometry(entry.action.operation)
}
