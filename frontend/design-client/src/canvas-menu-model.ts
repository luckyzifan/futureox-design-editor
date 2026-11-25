import { interfacePreference, type UiMode } from './interface-preference'
import { canvasCommandLabel, canvasText } from './canvas-interface-messages'
import type { Editor } from './engine'
import type { EditorCommand } from './editor-commands'
import { container, type Point } from './model'
import { userPages } from './fig-document'
import { shortcutLabel, shortcutPlatform, type ShortcutContext } from './shortcut-profiles'
import { getShortcutProfile } from './shortcut-preference'
import { desktopBridge } from './desktop'
import { selectionCommandAdmission } from './commands/selection-command'
import { alignmentAvailability, alignmentCommandIds, alignmentCommands } from './alignment-availability'
import { canMakeSketchGrid } from './sketch-make-grid'
import { selectedPaintSwap } from './sketch-paint-commands'
import { selectTopLevelCanvasIds } from './canvas-workflow-shortcuts'
import { pageMoveRoots } from './layer-drop'

export type CanvasMenuItem = { command: EditorCommand; label: string; group: string; disabled?: boolean; shortcut?: string; danger?: boolean }
export type ContextMenuOrigin = 'canvas' | 'empty-canvas' | 'layers' | 'inspector'
export function lockedSelectionIds(editor: Editor): string[] {
  const doc = editor.state.doc, parents = editor.parentMap(), locked = new Set<string>()
  for (const selected of editor.state.selection) {
    let id: string | undefined = selected
    while (id && doc.nodes[id]) { if (doc.nodes[id].locked) locked.add(id); id = parents.get(id) }
  }
  return [...locked]
}
export function canvasMenuItems(editor: Editor, context: ShortcutContext = { profile: getShortcutProfile(), platform: shortcutPlatform(), desktop: !!desktopBridge(), uiMode: interfacePreference.getSnapshot().uiMode }): CanvasMenuItem[] {
  const { doc, selection, busy } = editor.state, nodes = selection.map((id) => doc.nodes[id]).filter(Boolean)
  const roots = editor.topSelection(), parents = editor.parentMap(), locks = lockedSelectionIds(editor)
  const mutable = !!roots.length && !locks.length && !busy && !editor.interactionActive
  const siblings = roots.length > 0 && roots.every((id) => parents.get(id) === parents.get(roots[0]))
  // Desktop Figma order: clipboard, copy/paste as, stacking, group/frame,
  // auto layout, component, show/lock, flip, geometry, then extras.
  const items: CanvasMenuItem[] = []
  if (nodes.length) items.push(
    { command: 'copy', label: '复制', group: 'clipboard', disabled: busy || editor.interactionActive },
    { command: 'cut', label: '剪切', group: 'clipboard', disabled: !mutable },
    { command: 'paste-here', label: '粘贴到此处', group: 'clipboard', disabled: busy },
    { command: 'paste-in-place', label: '粘贴到原位', group: 'clipboard', disabled: busy },
    { command: 'paste-to-replace', label: '粘贴替换', group: 'clipboard', disabled: !mutable },
    { command: 'paste-over-selection', label: '覆盖粘贴（保留目标）', group: 'clipboard', disabled: !mutable || (context.profile === 'figma-like' && roots.length !== 1) },
    { command: 'duplicate', label: '创建副本', group: 'clipboard', disabled: !mutable },
    { command: 'delete', label: '删除', group: 'clipboard', disabled: !mutable, danger: true },
    { command:'copy-properties',label:'复制属性',group:'copy-as',disabled:nodes.length!==1||busy },
    { command:'paste-properties',label:'粘贴属性',group:'copy-as',disabled:!mutable },
    { command:'copy-fills',label:'复制填充',group:'copy-as',disabled:nodes.length!==1||busy },
    { command:'copy-strokes',label:'复制描边',group:'copy-as',disabled:nodes.length!==1||busy },
    { command:'copy-effects',label:'复制效果',group:'copy-as',disabled:nodes.length!==1||busy },
    { command: 'copy-as-png', label: '复制为 PNG', group: 'copy-as', disabled: busy || editor.interactionActive },
    { command: 'copy-as-svg', label: '复制为 SVG', group: 'copy-as', disabled: busy || editor.interactionActive },
    { command: 'bring-to-front', label: '置于顶层', group: 'order', disabled: !mutable },
    { command: 'bring-forward', label: '向上一层', group: 'order', disabled: !mutable },
    { command: 'send-backward', label: '向下一层', group: 'order', disabled: !mutable },
    { command: 'send-to-back', label: '置于底层', group: 'order', disabled: !mutable },
    { command: 'group', label: '编组', group: 'structure', disabled: !mutable || !siblings },
    { command: 'frame-selection', label: '创建选区画板', group: 'structure', disabled: !mutable || !siblings },
  )
  if (nodes.length && nodes.every((n) => (['group', 'frame', 'section'].includes(n.kind) || n.booleanOperation) && !n.component && !n.instance && !n.componentSet))
    items.push({ command: 'ungroup', label: '解除编组', group: 'structure', disabled: !mutable })
  if (nodes.length) items.push({ command: 'flatten', label: '展平', group: 'structure', disabled: !mutable || nodes.some(n => n.kind === 'text' || n.kind === 'slice' || !!n.instance || !!n.component || !!n.componentSet) })
  if (nodes.length) items.push({ command: 'auto-layout', label: '添加自动布局', group: 'layout', disabled: !mutable || !siblings })
  if (nodes.length === 1 && nodes[0].layout?.mode && nodes[0].layout.mode !== 'none') items.push({ command: 'remove-auto-layout', label: '移除自动布局', group: 'layout', disabled: !mutable })
  if (nodes.length) items.push(
    { command: 'create-component', label: '创建组件', group: 'component', disabled: !mutable || !siblings },
    { command: 'detach-instance', label: '分离实例', group: 'component', disabled: !mutable || nodes.length !== 1 || !nodes[0].instance },
    locks.length ? { command: 'unlock-selection', label: locks.some((id) => !selection.includes(id)) ? '解锁图层及父级' : '解锁图层', group: 'visibility', disabled: busy }
      : { command: 'lock-selection', label: '锁定图层', group: 'visibility', disabled: busy },
    nodes.every((n) => n.visible) ? { command: 'hide-selection', label: '隐藏图层', group: 'visibility', disabled: busy }
      : { command: 'show-selection', label: '显示图层', group: 'visibility', disabled: busy },
    { command: 'flip-horizontal', label: '水平翻转', group: 'transform', disabled: !mutable },
    { command: 'flip-vertical', label: '垂直翻转', group: 'transform', disabled: !mutable },
  )
  if (nodes.length && nodes.every((n) => !container(n) && n.kind !== 'text' && n.kind !== 'vector')) items.push({ command: 'convert-vector', label: '转换为矢量', group: 'geometry', disabled: !mutable })
  if (nodes.length && nodes.every((n) => !container(n) && n.kind !== 'text') && nodes.some((n) => n.strokes.some((stroke) => stroke.visible && stroke.width > 0)))
    items.push({ command: 'outline-stroke', label: '轮廓化描边', group: 'geometry', disabled: !mutable || !siblings })
  if (nodes.length) items.push({ command: 'mask-selection', label: '用作蒙版', group: 'geometry', disabled: !mutable || !siblings || roots.length < 2 })
  const namingGroup = context.uiMode === 'figma' ? 'structure' : 'naming'
  if (nodes.length) items.push({ command: 'rename', label: nodes.length > 1 ? '批量重命名…' : '重命名', group: namingGroup, disabled: busy || editor.interactionActive || (nodes.length > 1 && (!mutable || nodes.some(n => n.instanceOrigin))) })
  if (nodes.length && nodes.every(n => n.kind === 'frame' && !n.component && !n.instance && !n.componentSet)) items.push({ command: 'convert-section', label: '转换为分区', group: namingGroup, disabled: !mutable })
  if (nodes.length) {
    for (const [query, label] of [['matching','匹配图层'],['properties','相同属性'],['fill','相同填充'],['stroke','相同描边'],['effect','相同效果'],['text','相同文字属性'],['font','相同字体'],['instance','同一组件实例']] as const)
      items.push({ command: `select-${query}`, label: `选择${label}`, group: 'selection', disabled: busy })
    items.push({ command: 'select-inverse', label: '反选', group: 'selection', disabled: busy })
    items.push(
      { command: 'zoom-selection', label: '缩放至选区', group: 'view' },
      { command: 'center-selection', label: '居中选区（保留缩放）', group: 'view' },
    )
  } else items.push(
    { command: 'paste-here', label: '粘贴到此处', group: 'clipboard', disabled: busy },
    { command: 'paste-in-place', label: '粘贴到原位', group: 'clipboard', disabled: busy },
    { command: 'select-all', label: '全选', group: 'selection', disabled: !doc.pages.find((p) => p.id === editor.state.page)?.children.length },
    { command: 'zoom-fit', label: '缩放至全部内容', group: 'view', disabled: !doc.pages.find((p) => p.id === editor.state.page)?.children.length },
  )
  const visiblePages = userPages(doc)
  const pageIndex = visiblePages.findIndex(page => page.id === editor.state.page)
  const page = doc.pages.find(item => item.id === editor.state.page)
  if (context.uiMode === 'sketch' && context.profile === 'sketch-like') items.push(
    { command: 'select-all-force', label: '全选（含隐藏与锁定）', group: 'selection', disabled: !page?.children.length },
    { command: 'select-all-top-level', label: '全选顶层画框与图形', group: 'selection', disabled: !selectTopLevelCanvasIds(doc, editor.state.page).length },
  )
  const hasFrame = !!page?.children.some(id => doc.nodes[id]?.visible && (doc.nodes[id].kind === 'frame' || doc.nodes[id].kind === 'section'))
  items.push(
    { command: 'zoom-next-frame', label: '缩放到下一画板', group: 'view', disabled: !hasFrame },
    { command: 'zoom-previous-frame', label: '缩放到上一画板', group: 'view', disabled: !hasFrame },
    { command: 'next-page', label: '下一页', group: 'view', disabled: pageIndex < 0 || pageIndex >= visiblePages.length - 1 },
    { command: 'previous-page', label: '上一页', group: 'view', disabled: pageIndex <= 0 },
    { command: 'undo', label: '撤销', group: 'history', disabled: !editor.canUndo || busy },
    { command: 'redo', label: '重做', group: 'history', disabled: !editor.canRedo || busy },
  )
  const locale = interfacePreference.getSnapshot().locale
  return items.map(item => ({ ...item, label: canvasCommandLabel(item.command, item.label, locale, nodes.length > 1, locks.some(id => !selection.includes(id))), shortcut: shortcutLabel(item.command, context), disabled: !!item.disabled || busy || editor.interactionActive }))
}

export function sketchSelectionCommands(editor: Editor) {
  const { doc, selection, busy } = editor.state
  const roots = editor.topSelection(), chosen = new Set(roots), parents = editor.parentMap()
  const mutable = roots.length > 0 && !busy && !editor.interactionActive && !lockedSelectionIds(editor).length
  const parentsOfSelection = new Set(roots.map(id => parents.get(id)))
  const canStep = (step: 1 | -1) => mutable && [...parentsOfSelection].some(parent => {
    const siblings = (parent && doc.nodes[parent]?.children) || doc.pages.find(page => page.id === parent)?.children
    return siblings?.some((id, index) => {
      const neighbor = siblings[index + step]
      return chosen.has(id) && neighbor !== undefined && !chosen.has(neighbor)
    })
  })
  const canGroup = mutable && selectionCommandAdmission(doc, selection, 'wrap', parents).ok
  return {
    canBringForward: canStep(1),
    canSendBackward: canStep(-1),
    canGroup,
    canUngroup: mutable && selectionCommandAdmission(doc, selection, 'unwrap', parents).ok,
    canCombine: mutable && roots.length >= 2 && roots.length <= 64 &&
      roots.every(id => {
        const node = doc.nodes[id]
        return (!container(node) || !!node.booleanOperation) && node.kind !== 'text' && node.kind !== 'slice'
      }) && selectionCommandAdmission(doc, selection, 'boolean-wrap', parents).ok,
  }
}

/** Mac desktop right-click on a selected shape, top to bottom. Cloud-only
 * rows (Figma Make, Find similar, Add motion, Widgets) are omitted. Move to
 * page sits between Copy/Paste as and Bring to front. Plugins sits between
 * Create component and Show/Hide. The menu component inserts those two rows. */
const contextOrder: EditorCommand[] = [
  'copy', 'paste-here', 'paste-to-replace',
  'copy-properties', 'paste-properties', 'copy-fills', 'copy-strokes', 'copy-effects', 'copy-as-png', 'copy-as-svg',
  'bring-to-front', 'send-to-back', 'convert-section',
  'group', 'frame-selection', 'ungroup', 'rename', 'flatten', 'outline-stroke', 'mask-selection',
  'auto-layout', 'remove-auto-layout',
  'create-component', 'detach-instance',
  'hide-selection', 'show-selection', 'lock-selection', 'unlock-selection',
  'flip-horizontal', 'flip-vertical',
]
const sketchContextOrder: EditorCommand[] = [
  'cut', 'copy', 'paste', 'paste-in-place', 'paste-to-replace', 'duplicate', 'delete',
  'move-to-page', 'bring-forward', 'send-backward', 'copy-properties', 'paste-properties',
  'paste-properties-no-corners',
  'swap-fills-and-strokes',
  'select-all-force', 'select-all-top-level', 'select-inverse',
  'group', 'frame-selection', 'ungroup', 'rename', 'create-component', 'detach-instance', 'auto-layout', 'remove-auto-layout',
  'lock-selection', 'unlock-selection', 'hide-selection', 'show-selection',
  ...alignmentCommandIds,
  'make-grid',
  'flip-horizontal', 'flip-vertical', 'fit-pixel-bounds', 'round-to-pixel', 'mask-selection', 'convert-vector', 'outline-stroke',
]
const sketchLabels: Partial<Record<EditorCommand, readonly [string, string]>> = {
  'copy': ['拷贝', 'Copy'],
  'duplicate': ['复制', 'Duplicate'],
  'bring-to-front': ['移到最前面', 'Bring to Front'],
  'send-to-back': ['移到最后面', 'Send to Back'],
  'bring-forward': ['前置一层', 'Bring Forward'],
  'send-backward': ['后置一层', 'Send Backward'],
  'copy-properties': ['拷贝样式', 'Copy Style'],
  'paste-properties': ['粘贴样式', 'Paste Style'],
  'group': ['编组', 'Group'],
  'frame-selection': ['编组画框', 'Group as Frame'],
  'ungroup': ['取消编组', 'Ungroup'],
  'auto-layout': ['添加层叠布局', 'Add Stack Layout'],
  'remove-auto-layout': ['移除层叠布局', 'Remove Stack Layout'],
  'create-component': ['创建控件', 'Create Symbol'],
}
export function sketchCommandLabel(command: EditorCommand, locale: 'zh-CN' | 'en') {
  return sketchLabels[command]?.[locale === 'en' ? 1 : 0]
}
function contextPresentation(item: CanvasMenuItem, locale: 'zh-CN' | 'en'): CanvasMenuItem {
  if (item.command === 'hide-selection' || item.command === 'show-selection')
    return { ...item, label: locale === 'en' ? 'Show/Hide' : '显示/隐藏' }
  if (item.command === 'lock-selection' || item.command === 'unlock-selection')
    return { ...item, label: locale === 'en' ? 'Lock/Unlock' : '锁定/解锁' }
  return item
}
/** A rectangle with no stroke still lists Outline stroke, disabled. */
function disabledOutlineItem(editor: Editor, context: ShortcutContext): CanvasMenuItem | null {
  const nodes = editor.state.selection.map(id => editor.state.doc.nodes[id]).filter(Boolean)
  if (!nodes.length || nodes.some(n => container(n) || n.kind === 'text' || n.kind === 'slice')) return null
  const locale = interfacePreference.getSnapshot().locale
  return {
    command: 'outline-stroke',
    label: canvasCommandLabel('outline-stroke', '轮廓化描边', locale, nodes.length > 1, false),
    group: 'geometry',
    disabled: true,
    shortcut: shortcutLabel('outline-stroke', context),
  }
}
export function canvasContextItems(editor: Editor, context: ShortcutContext, uiMode: UiMode = 'figma',
  origin: ContextMenuOrigin = editor.state.selection.length ? 'canvas' : 'empty-canvas'): CanvasMenuItem[] {
  const available = new Map(canvasMenuItems(editor, { ...context, uiMode }).map(item => [item.command, item]))
  const { busy, selection } = editor.state
  const disabled = busy || editor.interactionActive
  const locale = interfacePreference.getSnapshot().locale
  if (origin === 'empty-canvas') {
    const paste = available.get('paste-here')!
    return uiMode === 'figma' ? [paste] : [paste, ...(['paste-in-place', 'select-all', 'select-all-force', 'select-all-top-level', 'zoom-fit'] as const).flatMap(command => {
      const item = available.get(command)
      return item ? [item] : []
    })]
  }
  if (uiMode === 'sketch') {
    const commands = sketchSelectionCommands(editor)
    if (selection.length) available.set('move-to-page', {
      command: 'move-to-page', label: canvasText[locale].moveToPage, group: 'stack',
      disabled: disabled || userPages(editor.state.doc).length < 2 ||
        !pageMoveRoots(editor.state.doc, editor.state.page, selection, editor.parentMap()),
    })
    const pasteStyle = available.get('paste-properties')
    if (pasteStyle) available.set('paste-properties-no-corners', {
      ...pasteStyle, command: 'paste-properties-no-corners',
      label: locale === 'en' ? 'Paste Style Without Corners' : '粘贴样式（保留圆角）',
      shortcut: shortcutLabel('paste-properties-no-corners', { ...context, uiMode }),
    })
    available.set('swap-fills-and-strokes', {
      command: 'swap-fills-and-strokes', group: 'style',
      label: locale === 'en' ? 'Swap Fills and Borders' : '交换填充和描边',
      disabled: disabled || !selectedPaintSwap(editor)?.length,
      shortcut: shortcutLabel('swap-fills-and-strokes', { ...context, uiMode }),
    })
    available.set('fit-pixel-bounds', { command: 'fit-pixel-bounds', group: 'geometry', disabled: disabled || !editor.topSelection().length,
      label: locale === 'en' ? 'Fit Selection to Pixel Bounds' : '贴合像素边界', shortcut: shortcutLabel('fit-pixel-bounds', context) })
    available.set('round-to-pixel', { command: 'round-to-pixel', group: 'geometry', disabled: disabled || !editor.topSelection().length,
      label: locale === 'en' ? 'Round to Pixel' : '四舍五入到像素', shortcut: shortcutLabel('round-to-pixel', context) })
    const canAlign = alignmentAvailability(editor).align
    for (const command of alignmentCommandIds) {
      const { label } = alignmentCommands[command]
      available.set(command, { command, label: label[locale === 'en' ? 1 : 0], group: 'alignment', disabled: !canAlign,
        shortcut: shortcutLabel(command, { ...context, uiMode }) })
    }
    if (selection.length) available.set('make-grid', {
      command: 'make-grid', label: locale === 'en' ? 'Make Grid…' : '制作网格…', group: 'arrange',
      disabled: disabled || !canMakeSketchGrid(editor),
    })
    available.set('paste', { command: 'paste', label: locale === 'en' ? 'Paste' : '粘贴', group: 'clipboard',
      disabled, shortcut: shortcutLabel('paste', context) })
    if (selection.length && !available.has('ungroup'))
      available.set('ungroup', { command: 'ungroup', label: '', group: 'structure', shortcut: shortcutLabel('ungroup', context) })
    return sketchContextOrder.flatMap(command => {
      const item = available.get(command), label = sketchCommandLabel(command, locale)
      if (!item || (command === 'detach-instance' && item.disabled)) return []
      const allowed = command === 'bring-forward' ? commands.canBringForward :
        command === 'send-backward' ? commands.canSendBackward : command === 'ungroup' ? commands.canUngroup :
        command === 'group' || command === 'frame-selection' ? commands.canGroup : !item.disabled
      return [{ ...item, label: label ?? item.label, disabled: !allowed }]
    })
  }
  if (!available.has('outline-stroke')) {
    const outline = disabledOutlineItem(editor, context)
    if (outline) available.set('outline-stroke', outline)
  }
  return contextOrder.flatMap(command => {
    if ((command === 'paste-here' && origin !== 'canvas')
        || (command === 'rename' && origin === 'canvas')) return []
    const item = available.get(command)
    if (!item || (command === 'detach-instance' && item.disabled)) return []
    return [contextPresentation(item, locale)]
  })
}
/** Plugins sits after Create component and before Show/Hide or Lock/Unlock. */
export function pluginsMenuIndex(commands: readonly string[]): number {
  const at = commands.findIndex(command => command === 'hide-selection' || command === 'show-selection' || command === 'lock-selection' || command === 'unlock-selection')
  return at < 0 ? commands.length : at
}
/** Where the page submenu sits in the Mac list: after Copy/Paste as, before stacking. */
export function moveToPageIndex(commands: readonly string[]): number {
  const stacking = commands.findIndex(command => command === 'bring-to-front' || command === 'send-to-back')
  return stacking < 0 ? commands.length : stacking
}

export function clampContextMenu(point: Point, size: { width: number; height: number }, viewport: { width: number; height: number }): Point {
  const margin = 8
  return {
    x: Math.max(margin, Math.min(point.x, Math.max(margin, viewport.width - size.width - margin))),
    y: Math.max(margin, Math.min(point.y, Math.max(margin, viewport.height - size.height - margin))),
  }
}
