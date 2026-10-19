import type { Editor } from './engine'
import type { EditorCommand } from './editor-commands'
import { allParents } from './geometry'
import { container, type Point } from './model'
import { shortcutLabel, shortcutPlatform, type ShortcutContext } from './shortcut-profiles'
import { shortcutPreference } from './shortcut-preference'
import { desktopBridge } from './desktop'

export type CanvasMenuItem = { command: EditorCommand; label: string; group: string; disabled?: boolean; shortcut?: string; danger?: boolean }
export function lockedSelectionIds(editor: Editor): string[] {
  const doc = editor.state.doc, parents = allParents(doc), locked = new Set<string>()
  for (const selected of editor.state.selection) {
    let id: string | undefined = selected
    while (id && doc.nodes[id]) { if (doc.nodes[id].locked) locked.add(id); id = parents.get(id) }
  }
  return [...locked]
}
export function canvasMenuItems(editor: Editor, context: ShortcutContext = { profile: shortcutPreference.getSnapshot(), platform: shortcutPlatform(), desktop: !!desktopBridge() }): CanvasMenuItem[] {
  const { doc, selection, busy } = editor.state, nodes = selection.map((id) => doc.nodes[id]).filter(Boolean)
  const roots = editor.topSelection(), parents = allParents(doc), locks = lockedSelectionIds(editor)
  const mutable = !!roots.length && !locks.length && !busy && !editor.interactionActive
  const siblings = roots.length > 0 && roots.every((id) => parents.get(id) === parents.get(roots[0]))
  const items: CanvasMenuItem[] = [
    { command: 'undo', label: '撤销', group: 'history', disabled: !editor.canUndo || busy },
    { command: 'redo', label: '重做', group: 'history', disabled: !editor.canRedo || busy },
  ]
  if (nodes.length) items.push(
    { command: 'paste-over-selection', label: '覆盖粘贴（保留目标）', group: 'clipboard', disabled: !mutable || (context.profile === 'figma-like' && roots.length !== 1) },
    { command: 'paste-to-replace', label: '粘贴替换', group: 'clipboard', disabled: !mutable },
    { command:'copy-properties',label:'复制属性',group:'copy-as',disabled:nodes.length!==1||busy },
    { command:'paste-properties',label:'粘贴属性',group:'copy-as',disabled:!mutable },
    { command:'copy-fills',label:'复制填充',group:'copy-as',disabled:nodes.length!==1||busy },
    { command:'copy-strokes',label:'复制描边',group:'copy-as',disabled:nodes.length!==1||busy },
    { command:'copy-effects',label:'复制效果',group:'copy-as',disabled:nodes.length!==1||busy },
    { command: 'copy-as-png', label: '复制为 PNG', group: 'copy-as', disabled: busy || editor.interactionActive },
    { command: 'copy-as-svg', label: '复制为 SVG', group: 'copy-as', disabled: busy || editor.interactionActive },
    { command: 'copy', label: '复制', group: 'clipboard', disabled: busy || editor.interactionActive },
    { command: 'cut', label: '剪切', group: 'clipboard', disabled: !mutable },
  )
  items.push(
    { command: 'paste-here', label: '粘贴到此处', group: 'clipboard', disabled: busy },
    { command: 'paste-in-place', label: '粘贴到原位', group: 'clipboard', disabled: busy },
  )
  if (nodes.length) {
    for(const [query,label] of [['matching','匹配图层'],['properties','相同属性'],['fill','相同填充'],['stroke','相同描边'],['effect','相同效果'],['text','相同文字属性'],['font','相同字体'],['instance','同一组件实例']] as const)
      items.push({command:`select-${query}`,label:`选择${label}`,group:'selection',disabled:busy})
    items.push({command:'select-inverse',label:'反选',group:'selection',disabled:busy})
    if (nodes.length === 1) items.push({ command: 'rename', label: '重命名', group: 'structure', disabled: busy || editor.interactionActive })
    items.push({ command: 'duplicate', label: '创建副本', group: 'clipboard', disabled: !mutable })
    items.push(
      { command: 'flip-horizontal', label: '水平翻转', group: 'transform', disabled: !mutable },
      { command: 'flip-vertical', label: '垂直翻转', group: 'transform', disabled: !mutable },
      { command: 'bring-to-front', label: '置于顶层', group: 'order', disabled: !mutable },
      { command: 'bring-forward', label: '向上一层', group: 'order', disabled: !mutable },
      { command: 'send-backward', label: '向下一层', group: 'order', disabled: !mutable },
      { command: 'send-to-back', label: '置于底层', group: 'order', disabled: !mutable },
      { command: 'group', label: '编组', group: 'structure', disabled: !mutable || !siblings },
    )
    items.push(
      { command: 'frame-selection', label: '创建选区画板', group: 'structure', disabled: !mutable || !siblings },
      { command: 'create-component', label: '创建组件', group: 'structure', disabled: !mutable || !siblings },
      { command: 'mask-selection', label: '用作蒙版', group: 'structure', disabled: !mutable || !siblings || roots.length < 2 },
      { command: 'auto-layout', label: '添加自动布局', group: 'layout', disabled: !mutable || !siblings },
    )
    if (nodes.length === 1 && nodes[0].layout?.mode && nodes[0].layout.mode !== 'none') items.push({ command: 'remove-auto-layout', label: '移除自动布局', group: 'layout', disabled: !mutable })
    if (nodes.every(n => n.kind === 'frame' && !n.component && !n.instance && !n.componentSet)) items.push({ command: 'convert-section', label: '转换为分区', group: 'structure', disabled: !mutable })
    if (nodes.every((n) => (['group', 'frame', 'section'].includes(n.kind) || n.booleanOperation) && !n.component && !n.instance && !n.componentSet)) items.push({ command: 'ungroup', label: '解除编组', group: 'structure', disabled: !mutable })
    if (nodes.every((n) => !container(n) && n.kind !== 'text' && n.kind !== 'vector')) items.push({ command: 'convert-vector', label: '转换为矢量', group: 'geometry', disabled: !mutable })
    if (nodes.every((n) => !container(n) && n.kind !== 'text') && nodes.some((n) => n.strokes.some((stroke) => stroke.visible && stroke.width > 0)))
      items.push({ command: 'outline-stroke', label: '轮廓化描边', group: 'geometry', disabled: !mutable || !siblings })
    items.push(
      locks.length ? { command: 'unlock-selection', label: locks.some((id) => !selection.includes(id)) ? '解锁图层及父级' : '解锁图层', group: 'visibility', disabled: busy }
        : { command: 'lock-selection', label: '锁定图层', group: 'visibility', disabled: busy },
      nodes.every((n) => n.visible) ? { command: 'hide-selection', label: '隐藏图层', group: 'visibility', disabled: busy }
        : { command: 'show-selection', label: '显示图层', group: 'visibility', disabled: busy },
      { command: 'zoom-selection', label: '缩放至选区', group: 'view' },
      { command: 'center-selection', label: '居中选区（保留缩放）', group: 'view' },
      { command: 'delete', label: '删除', group: 'delete', disabled: !mutable, danger: true },
    )
  } else items.push(
    { command: 'select-all', label: '全选', group: 'selection', disabled: !doc.pages.find((p) => p.id === editor.state.page)?.children.length },
    { command: 'zoom-fit', label: '缩放至全部内容', group: 'view', disabled: !doc.pages.find((p) => p.id === editor.state.page)?.children.length },
  )
  return items.map(item => ({ ...item, shortcut: shortcutLabel(item.command, context), disabled: !!item.disabled || busy || editor.interactionActive }))
}

export function clampContextMenu(point: Point, size: { width: number; height: number }, viewport: { width: number; height: number }): Point {
  const margin = 8
  return {
    x: Math.max(margin, Math.min(point.x, Math.max(margin, viewport.width - size.width - margin))),
    y: Math.max(margin, Math.min(point.y, Math.max(margin, viewport.height - size.height - margin))),
  }
}
