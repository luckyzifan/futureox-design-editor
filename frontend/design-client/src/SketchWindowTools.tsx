import { type ReactNode, useRef, useState, useSyncExternalStore } from 'react'
import { ArrowDownToLine, ArrowUpToLine, Component, Crop, Frame, Group, PenTool, Plus, Search, Shapes, SlidersHorizontal, SquareDashed, TextCursor, Type } from 'lucide-react'
import { DesignToolbar, ToolPopover, type WorkspaceSection } from './EditorChrome'
import type { Editor, Tool } from './engine'
import { dispatchEditorCommand, type EditorCommand } from './editor-commands'
import { canvasMenuItems, lockedSelectionIds, sketchSelectionCommands } from './canvas-menu-model'
import { activateTool } from './tool-activation'
import { canvasText } from './canvas-interface-messages'
import { commandSearchText } from './command-search'
import { requestCommandSearch } from './command-search-session'
import { useInterfacePreferences } from './interface-preference'
import { localizedToolLabel } from './tool-registry'
import { RASTER_FILE_ACCEPT } from './image-import'
import { canEnterOutlineEdit } from './figma-basic-ops'
import { commitPendingEdits } from './pending-edits'
import { editableFrameCrop } from './selection-properties'
import { frameSizePresetGate } from './frame-presets'
import { sketchInsertTools, sketchToolMenu } from './interface-layout'

type Menu = 'insert' | 'shapes' | 'group' | 'tools' | 'combine'

export function SketchWindowTools({ editor, disabled, onPresets, onInsertTextStyle, onInsertSymbol, onReplaceTemplate, onImages, onSystems, onShapeBuilder, onSection, onEditText }: {
  editor: Editor
  disabled: boolean
  onPresets: () => void
  onInsertTextStyle?: () => void
  onInsertSymbol?: () => void
  onReplaceTemplate?: () => void
  onImages: (files: File[]) => void
  onSystems: () => void
  onShapeBuilder: () => void
  onSection: (section: WorkspaceSection) => void
  onEditText: (id: string) => void
}) {
  const { locale } = useInterfacePreferences(), text = canvasText[locale]
  const [open, setOpen] = useState<Menu | null>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const s = useSyncExternalStore(editor.subscribe, editor.panelSnapshot)
  const selected = editor.topSelection(), node = selected.length === 1 ? s.doc.nodes[selected[0]] : undefined
  const commands = canvasMenuItems(editor)
  const { canBringForward, canSendBackward, canGroup, canUngroup, canCombine } = sketchSelectionCommands(editor)
  const label = (zh: string, en: string) => locale === 'en' ? en : zh
  const available: Partial<Record<EditorCommand, boolean>> = {
    'bring-forward': canBringForward, 'send-backward': canSendBackward,
    group: canGroup, 'frame-selection': canGroup, 'graphic-selection': canGroup, ungroup: canUngroup,
  }
  const allowed = (id: EditorCommand) => available[id] ?? commands.some(command => command.command === id && !command.disabled)
  const focusCanvas = () => document.querySelector<HTMLElement>('[data-testid="canvas"]')?.focus({ preventScroll: true })
  const invoke = (id: EditorCommand) => { setOpen(null); focusCanvas(); void dispatchEditorCommand(editor, id) }
  const tool = (id: Tool) => { setOpen(null); void activateTool(editor, id); focusCanvas() }
  const editLabel = label('编辑', 'Edit')
  const replaceLabel = label('替换画框模板…', 'Replace Frame Template…')
  const cropFrame = editableFrameCrop(editor)
  const canEdit = !!node && !s.busy && !editor.interactionActive && !lockedSelectionIds(editor).length &&
    (!!cropFrame || (node.kind === 'text' ? node.visible : canEnterOutlineEdit(node)))
  const edit = () => {
    setOpen(null)
    if (!node || !canEdit || !commitPendingEdits(editor) || editor.state.selection[0] !== node.id) return
    if (cropFrame === node.id) invoke('edit-frame-bounds')
    else if (node.kind === 'text') onEditText(node.id)
    else if (s.tool === 'vector') tool('select')
    else { editor.set({ tool: 'vector', editingVertex: null, editingVertices: [] }); focusCanvas() }
  }
  const action = (id: EditorCommand, name: string, icon: ReactNode, secondary = false) =>
    <button type="button" aria-label={name} data-tooltip={name} disabled={!allowed(id)}
      className={secondary ? 'sketch-secondary-tool' : undefined} onClick={() => invoke(id)}>{icon}</button>
  const menuAction = (id: EditorCommand, name: string) =>
    <button type="button" role="menuitem" tabIndex={-1} disabled={!allowed(id)} onClick={() => invoke(id)}>{name}</button>
  const menuTool = (id: Tool) =>
    <button type="button" role="menuitemradio" tabIndex={-1} key={id} aria-checked={s.tool === id}
      onClick={() => tool(id)}>{id === 'frame' ? label('画框','Frame') : localizedToolLabel(id, locale)}</button>
  const insertTool = (id: Tool, name: string, icon: ReactNode) =>
    <button type="button" aria-label={name} data-tooltip={name} aria-pressed={s.tool === id} onClick={() => tool(id)}>{icon}</button>
  const menu = (id: Menu, name: string, icon: ReactNode, children: ReactNode, enabled = true) =>
    <ToolPopover label={name} icon={icon} disabled={!enabled} open={enabled && open === id}
      onOpenChange={next => setOpen(next ? id : null)}>{children}</ToolPopover>
  return <DesignToolbar className="sketch-window-tools" disabled={disabled}>
    <div className="tool-group">
      <button type="button" className="sketch-secondary-tool command-search-trigger" aria-label={commandSearchText[locale].label}
        data-tooltip={`${commandSearchText[locale].label} (S)`} onClick={() => requestCommandSearch()}><Search size={17} /></button>
      {menu('insert', label('置入', 'Insert'), <Plus size={18} />, <>
        {sketchInsertTools.map(menuTool)}
        {onInsertTextStyle && <button type="button" role="menuitem" tabIndex={-1}
          onClick={() => { setOpen(null); onInsertTextStyle() }}>{label('文字样式…', 'Text Style…')}</button>}
        {onInsertSymbol && <button type="button" role="menuitem" tabIndex={-1}
          onClick={() => { setOpen(null); onInsertSymbol() }}>{label('控件…', 'Symbol…')}</button>}
        <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setOpen(null); imageInput.current?.click() }}>{label('图片…', 'Image…')}</button>
        <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setOpen(null); onPresets() }}>{text.devicePresets}</button>
      </>)}
      <input ref={imageInput} type="file" accept={RASTER_FILE_ACCEPT} multiple hidden onChange={event => {
        const files = [...(event.target.files || [])]; event.target.value = ''
        if (files.length) onImages(files)
      }} />
    </div>
    {!selected.length && <div className="tool-group">
      {insertTool('frame', label('画框','Frame'), <Frame size={17}/>)}
      {insertTool('graphic', label('图形','Graphic'), <SquareDashed size={17}/>)}
      {insertTool('text', label('字符','Text'), <Type size={17}/>)}
      {menu('shapes', label('形状','Shapes'), <Shapes size={17}/>,
        (['rectangle','ellipse','line','arrow','polygon','star'] as const).map(menuTool))}
      {insertTool('pen', label('矢量','Vector'), <PenTool size={17}/>)}
    </div>}
    <div className="tool-group">
      {onReplaceTemplate && node?.kind === 'frame' && !node.graphic && <button type="button"
        aria-label={replaceLabel} aria-haspopup="dialog" data-tooltip={`${replaceLabel} (⌥⌘R)`}
        disabled={s.busy || frameSizePresetGate(s.doc, s.page, s.selection, editor.parentMap()) !== 'ready'}
        onClick={onReplaceTemplate}><Frame size={17} /></button>}
      {action('create-component', label('创建组件', 'Create component'), <Component size={17} />, true)}
      {action('bring-forward', label('前置一层', 'Bring forward'), <ArrowUpToLine size={17} />, true)}
      {action('send-backward', label('后置一层', 'Send backward'), <ArrowDownToLine size={17} />, true)}
      {menu('group', text.group, <Group size={17} />, <>
        {menuAction('frame-selection', label('画框', 'Frame'))}
        {menuAction('graphic-selection', label('图形', 'Graphic'))}
        {menuAction('group', text.group)}
        {menuAction('auto-layout', label('层叠', 'Stack'))}
        {menuAction('ungroup', label('取消编组', 'Ungroup'))}
      </>, canGroup || canUngroup)}
      <button type="button" className="sketch-secondary-tool" aria-pressed={!!s.frameCrop || s.tool === 'vector' && node?.kind !== 'text'}
        aria-label={editLabel} data-tooltip={editLabel} disabled={!canEdit} onClick={edit}>
        {cropFrame ? <Crop size={17} /> : node?.kind === 'text' ? <TextCursor size={17} /> : <PenTool size={17} />}
      </button>
      {menu('tools', label('工具', 'Tools'), <SlidersHorizontal size={17} />, <>
        {sketchToolMenu.map(menuTool)}
        <button type="button" role="menuitem" tabIndex={-1} disabled={!canEdit} onClick={edit}>{editLabel}</button>
        {menuAction('bring-forward', label('前置一层', 'Bring forward'))}
        {menuAction('send-backward', label('后置一层', 'Send backward'))}
        {menuAction('create-component', label('创建组件', 'Create component'))}
        {menuAction('undo', text.undo)}{menuAction('redo', text.redo)}
        {menuAction('mask-selection', text.maskGroup)}
        <button type="button" role="menuitem" tabIndex={-1} disabled={!selected.length || s.busy}
          onClick={() => { setOpen(null); onShapeBuilder() }}>{text.shapeBuilder}</button>
        <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setOpen(null); onSection('layers') }}>{label('显示画布', 'Show canvas')}</button>
        <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setOpen(null); onSection('assets') }}>{label('显示组件', 'Show components')}</button>
        <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setOpen(null); requestCommandSearch() }}>{commandSearchText[locale].label}</button>
        <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setOpen(null); onSystems() }}>{label('变量 · 组件库', 'Variables · Libraries')}</button>
      </>)}
      {menu('combine', label('结合', 'Combine'), <Shapes size={17} />, <>
        {([['boolean-add', label('添加形状', 'Add Shapes')], ['boolean-union', text.union], ['boolean-subtract', text.subtract],
          ['boolean-intersect', text.intersect], ['boolean-exclude', text.exclude]] as const)
          .map(([command, name]) => <button type="button" role="menuitem" tabIndex={-1} key={command}
            onClick={() => invoke(command)}>{name}</button>)}
        <button type="button" role="menuitem" tabIndex={-1}
          onClick={() => { setOpen(null); void editor.geometry('divide') }}>{text.divideLegacy}</button>
      </>, canCombine)}
    </div>
  </DesignToolbar>
}
