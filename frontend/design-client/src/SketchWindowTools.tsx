import { type ReactNode, useRef, useState, useSyncExternalStore } from 'react'
import { ArrowDownToLine, ArrowUpToLine, Component, Group, PenTool, Plus, Search, Shapes, SlidersHorizontal } from 'lucide-react'
import { DesignToolbar, ToolPopover, type WorkspaceSection } from './EditorChrome'
import type { Editor, Tool } from './engine'
import { dispatchEditorCommand, type EditorCommand } from './editor-commands'
import { canvasMenuItems } from './canvas-menu-model'
import { activateTool } from './tool-activation'
import { canvasText } from './canvas-interface-messages'
import { commandSearchText } from './command-search'
import { requestCommandSearch } from './command-search-session'
import { useInterfacePreferences } from './interface-preference'
import { localizedToolLabel } from './tool-registry'
import { RASTER_FILE_ACCEPT } from './image-import'

type Menu = 'insert' | 'group' | 'tools' | 'combine'

export function SketchWindowTools({ editor, disabled, onPresets, onImages, onSystems, onShapeBuilder, onSection }: {
  editor: Editor
  disabled: boolean
  onPresets: () => void
  onImages: (files: File[]) => void
  onSystems: () => void
  onShapeBuilder: () => void
  onSection: (section: WorkspaceSection) => void
}) {
  const { locale } = useInterfacePreferences(), text = canvasText[locale]
  const [open, setOpen] = useState<Menu | null>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const s = useSyncExternalStore(editor.subscribe, editor.panelSnapshot)
  const selected = editor.topSelection(), node = selected.length === 1 ? s.doc.nodes[selected[0]] : undefined
  const commands = canvasMenuItems(editor)
  const label = (zh: string, en: string) => locale === 'en' ? en : zh
  const allowed = (id: EditorCommand) => id === 'undo' ? editor.canUndo && !s.busy :
    id === 'redo' ? editor.canRedo && !s.busy : commands.some(command => command.command === id && !command.disabled)
  const focusCanvas = () => document.querySelector<HTMLElement>('[data-testid="canvas"]')?.focus({ preventScroll: true })
  const invoke = (id: EditorCommand) => { setOpen(null); focusCanvas(); void dispatchEditorCommand(editor, id) }
  const tool = (id: Tool) => { setOpen(null); void activateTool(editor, id); focusCanvas() }
  const edit = () => {
    setOpen(null)
    if (s.tool === 'vector') tool('select')
    else if (node && !node.locked) { editor.set({ tool: 'vector', editingVertex: null }); focusCanvas() }
  }
  const canEdit = !!node && !node.locked && !s.busy && !['frame', 'section', 'group', 'text', 'slice'].includes(node.kind)
  const action = (id: EditorCommand, name: string, icon: ReactNode, secondary = false) =>
    <button type="button" aria-label={name} data-tooltip={name} disabled={!allowed(id)}
      className={secondary ? 'sketch-secondary-tool' : undefined} onClick={() => invoke(id)}>{icon}</button>
  const menuAction = (id: EditorCommand, name: string) =>
    <button type="button" role="menuitem" tabIndex={-1} disabled={!allowed(id)} onClick={() => invoke(id)}>{name}</button>
  const menuTool = (id: Tool) =>
    <button type="button" role="menuitemradio" tabIndex={-1} key={id} aria-checked={s.tool === id}
      onClick={() => tool(id)}>{localizedToolLabel(id, locale)}</button>
  const menu = (id: Menu, name: string, icon: ReactNode, children: ReactNode) =>
    <ToolPopover label={name} icon={icon} open={open === id} onOpenChange={next => setOpen(next ? id : null)}>{children}</ToolPopover>
  return <DesignToolbar className="sketch-window-tools" disabled={disabled}>
    <div className="tool-group">
      <button type="button" className="sketch-secondary-tool command-search-trigger" aria-label={commandSearchText[locale].label}
        data-tooltip={`${commandSearchText[locale].label} (S)`} onClick={() => requestCommandSearch()}><Search size={17} /></button>
      {menu('insert', label('置入', 'Insert'), <Plus size={18} />, <>
        {(['frame', 'section', 'slice', 'rectangle', 'ellipse', 'line', 'arrow', 'polygon', 'star', 'pen', 'text'] as const).map(menuTool)}
        <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setOpen(null); imageInput.current?.click() }}>{label('图片…', 'Image…')}</button>
        <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setOpen(null); onPresets() }}>{text.devicePresets}</button>
      </>)}
      <input ref={imageInput} type="file" accept={RASTER_FILE_ACCEPT} multiple hidden onChange={event => {
        const files = [...(event.target.files || [])]; event.target.value = ''
        if (files.length) onImages(files)
      }} />
    </div>
    <div className="tool-group">
      {action('create-component', label('创建组件', 'Create component'), <Component size={17} />, true)}
      {action('bring-forward', label('前置一层', 'Bring forward'), <ArrowUpToLine size={17} />, true)}
      {action('send-backward', label('后置一层', 'Send backward'), <ArrowDownToLine size={17} />, true)}
      {menu('group', text.group, <Group size={17} />, <>
        {menuAction('group', text.group)}
        {menuAction('ungroup', text.ungroup)}
        {menuAction('frame-selection', label('将所选图层放入画板', 'Frame selection'))}
      </>)}
      <button type="button" className="sketch-secondary-tool" aria-pressed={s.tool === 'vector'}
        aria-label={text.editVector} data-tooltip={text.editVector} disabled={!canEdit} onClick={edit}><PenTool size={17} /></button>
      {menu('tools', label('工具', 'Tools'), <SlidersHorizontal size={17} />, <>
        {(['select', 'hand', 'scale', 'zoom', 'pencil', 'brush', 'eraser', 'comments', 'eyedropper'] as const).map(menuTool)}
        <button type="button" role="menuitem" tabIndex={-1} disabled={!canEdit} onClick={edit}>{text.editVector}</button>
        {menuAction('bring-forward', label('前置一层', 'Bring forward'))}
        {menuAction('send-backward', label('后置一层', 'Send backward'))}
        {menuAction('create-component', label('创建组件', 'Create component'))}
        {menuAction('undo', text.undo)}{menuAction('redo', text.redo)}
        <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setOpen(null); onSection('layers') }}>{label('显示画布', 'Show canvas')}</button>
        <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setOpen(null); onSection('assets') }}>{label('显示组件', 'Show components')}</button>
        <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setOpen(null); requestCommandSearch() }}>{commandSearchText[locale].label}</button>
        <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setOpen(null); onSystems() }}>{text.designSystems}</button>
      </>)}
      {menu('combine', label('结合', 'Combine'), <Shapes size={17} />, <>
        {([['union', text.union], ['subtract', text.subtract], ['intersect', text.intersect], ['exclude', text.exclude], ['divide', text.divideLegacy]] as const)
          .map(([operation, name]) => <button type="button" role="menuitem" tabIndex={-1} key={operation} disabled={selected.length < 2 || s.busy}
            onClick={() => { setOpen(null); void editor.geometry(operation) }}>{name}</button>)}
        {menuAction('mask-selection', text.maskGroup)}
        <button type="button" role="menuitem" tabIndex={-1} disabled={!selected.length || s.busy}
          onClick={() => { setOpen(null); onShapeBuilder() }}>{text.shapeBuilder}</button>
      </>)}
    </div>
  </DesignToolbar>
}
