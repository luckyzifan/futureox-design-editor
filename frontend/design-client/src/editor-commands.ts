import { ownedPropertyPreviewTarget } from './property-preview'
import { beginEditorAction } from './editor-action-route'
import { CanvasAction, ActionSource, ActionOutcome, ActionReason, type ActionSourceCode } from './canvas-action-diagnostics'
import {PROPERTY_PREFIX,copyProperties,readProperties,pasteProperties,type PropertyKind} from './property-clipboard'
import { requestBatchRename } from './batch-rename-session'
import {activateTool} from './tool-activation'
import { copySelectionAsset } from './clipboard-export'
import { modalOwnsKeyboard, editableOwnsKeyboard } from './modal-keyboard'
import { requestSketchSymbolDialog } from './sketch-symbol'
import { fitSelectionToPixelBounds, roundSelectionToPixels } from './sketch-pixel-alignment'
import type { Editor } from './engine'
import { desktopBridge } from './desktop'
import { assertClipboardSize as assertSize, CLIPBOARD_TEXT_PREFIX as TEXT_PREFIX, readEditorClipboard as readClipboard, writeWebGraphClipboard } from './clipboard-adapter'
import { commitPendingEdits } from './pending-edits'
import { blank, defaultSizing, node, paint, type Bounds, type DesignNode, type DesignDocument, type Point } from './model'
import { clearWholeTextRunColor } from './text'
import { lockedSelectionIds, sketchSelectionCommands } from './canvas-menu-model'
import { fitBounds, fitSelectedBounds, zoomAt, zoomStep } from './canvas-camera'
import { jumpFrame, jumpPage, jumpToNode, selectedTopLevelFrameBounds } from './canvas-navigation'
import { togglePrototypeTab } from './prototype-chrome'
import { allParents, apply, bounds, unionBounds, worldMatrix } from './geometry'
import { selectionParentBounds } from './canvas-view'
import { sketchAutoPin } from './sketch-auto-pin'
import { swapSelectionPaints, toggleSketchPaintVisibility } from './sketch-paint-commands'
import { canFitFrameContents, editableFrameCrop, frameCropPatches } from './selection-properties'
import { interfacePreference } from './interface-preference'
import { interactivePath } from './selection-hierarchy'
import {querySelection,type SelectionQuery} from './selection-queries'
import { dimensionNudgeCommands, isDimensionNudgeCommand, nudgeSelectionDimensions, selectAllCanvasIds, type DimensionNudgeCommand } from './canvas-workflow-shortcuts'
import { activateDocumentFonts } from './kernel/picking'
import { applyPasteOverPlan, planPasteOverSelection } from './paste-over-selection'
import { shortcutPreference } from './shortcut-preference'
import { alignSelection, alignmentCommandIds, alignmentCommands, isAlignmentCommand, type AlignmentCommand } from './alignment-availability'
import { isSketchBooleanCommand, sketchBooleanCommands, sketchBooleanCommandIds, type SketchBooleanCommand } from './sketch-boolean-commands'
import type { ShortcutProfile } from './shortcut-profiles'

import { toolForCommand, unavailableReason, TOOL_COMMANDS } from './tool-registry'

export type SetToolCommand = `set-tool-${string}`
type SketchPixelCommand = 'fit-pixel-bounds' | 'round-to-pixel'
export type EditorCommand = SketchPixelCommand | SketchBooleanCommand | AlignmentCommand | 'graphic-selection' | 'edit-frame-bounds' | 'toggle-outlines' | DimensionNudgeCommand | 'copy-properties'|'paste-properties'|'paste-properties-no-corners'|'copy-fills'|'copy-strokes'|'copy-effects' | SetToolCommand | `select-${SelectionQuery}` | 'rename' | 'new-page' | 'frame-selection' | 'auto-layout' | 'remove-auto-layout' | 'auto-pin-contents' | 'auto-pin-selection' | 'create-component' | 'detach-instance' | 'mask-selection' | 'convert-section' | 'move-to-page' | 'copy-as-png' | 'copy-as-svg' | 'undo' | 'redo' | 'copy' | 'cut' | 'paste' | 'paste-to-replace' | 'paste-in-place' | 'paste-over-selection' | 'paste-here' | 'delete' | 'duplicate' | 'group' | 'ungroup' | 'select-all' | 'zoom-in' | 'zoom-out' | 'zoom-100' | 'zoom-fit' | 'zoom-selection' | 'zoom-top-level-frame' | 'zoom-next-frame' | 'zoom-previous-frame' | 'next-page' | 'previous-page' | 'eraser-or-prototype' | 'jump-to-node' | 'center-selection' | 'fit-frame-content' | 'flip-horizontal' | 'flip-vertical' | 'bring-to-front' | 'send-to-back' | 'bring-forward' | 'send-backward' | 'lock-selection' | 'unlock-selection' | 'hide-selection' | 'show-selection' | 'outline-stroke' | 'flatten' | 'convert-vector' | 'remove-stroke' | 'remove-fill' | 'swap-fills-and-strokes' | 'toggle-sketch-borders' | 'toggle-sketch-fills'
export const editorCommands: readonly EditorCommand[] = [...dimensionNudgeCommands,'fit-pixel-bounds','round-to-pixel','copy-properties','paste-properties','copy-fills','copy-strokes','copy-effects',...(['fill','stroke','effect','text','font','instance','properties','matching','inverse'] as const).map(q=>`select-${q}` as const), ...TOOL_COMMANDS.map((c) => `set-tool-${c.id.slice(9)}` as const).filter((v, i, a) => a.indexOf(v) === i), 'rename','frame-selection','auto-layout','remove-auto-layout','create-component','detach-instance','mask-selection','convert-section','move-to-page','copy-as-png','copy-as-svg','undo','redo','copy','cut','paste','paste-to-replace','paste-in-place','paste-over-selection','paste-here','delete','duplicate','group','ungroup','select-all','zoom-in','zoom-out','zoom-100','zoom-fit','zoom-selection','center-selection','flip-horizontal','flip-vertical','bring-to-front','send-to-back','bring-forward','send-backward','lock-selection','unlock-selection','hide-selection','show-selection','outline-stroke','flatten','convert-vector','new-page','zoom-next-frame','zoom-previous-frame','next-page','previous-page','eraser-or-prototype','jump-to-node','fit-frame-content','graphic-selection','edit-frame-bounds','toggle-outlines','remove-stroke','remove-fill', ...alignmentCommandIds, ...sketchBooleanCommandIds, 'zoom-top-level-frame', 'auto-pin-contents', 'auto-pin-selection', 'swap-fills-and-strokes', 'toggle-sketch-borders', 'toggle-sketch-fills', 'paste-properties-no-corners']
/** Normalize the native menu/accelerator bridge at one renderer boundary.
 * Focus ownership remains in dispatchEditorCommand, not in the native host. */
export function resolveDesktopEditorCommand(name: string): EditorCommand | undefined {
  const canonical = name === 'zoomIn' ? 'zoom-in' : name === 'zoomOut' ? 'zoom-out' : name === 'zoom100' ? 'zoom-100' : name
  return editorCommands.includes(canonical as EditorCommand) ? canonical as EditorCommand : undefined
}
const copiedPackets = new WeakMap<Editor, string>()
function packet(document: DesignDocument) { return JSON.stringify({ format:'forma-nodes', version:1, document, roots:document.pages[0].children }) }
function finiteBox(box: Bounds | undefined): box is Bounds {
  return !!box && [box.x, box.y, box.width, box.height].every(Number.isFinite) && box.width > 0 && box.height > 0
}
function nodeWorldBox(editor: Editor, id: string, parents = allParents(editor.state.doc)): Bounds | undefined {
  const node = editor.state.doc.nodes[id]
  if (!node || !node.visible) return
  const matrix = worldMatrix(editor.state.doc, id, parents)
  return bounds([{ x: 0, y: 0 }, { x: node.width, y: 0 }, { x: 0, y: node.height }, { x: node.width, y: node.height }].map(point => apply(matrix, point)))
}
/** World bounds of the selection. Scene entries are the usual source. A box
 * that does not contain the node's world center is a local or stale box and
 * cannot be used to center a high-zoom camera: that is how a 664×707 group
 * nested in a distant frame stays off the pasteboard.
 * Empty, hidden, off-page and missing ids do not move the camera. Locked
 * layers on the current page still do: lock is not visibility. */
export function selectionCameraBox(editor: Editor): Bounds | undefined {
  const parents = allParents(editor.state.doc)
  const ids = editor.state.selection.filter(id => interactivePath(editor.state.doc, editor.state.page, id, true, parents).length > 0)
  if (!ids.length) return
  const selected = new Set(ids)
  const entries = editor.entries().filter(entry => selected.has(entry.id))
  const sceneBox = entries.length ? unionBounds(entries.map(entry => entry.bounds)) : undefined
  const directBoxes = ids.flatMap(id => {
    const box = nodeWorldBox(editor, id, parents)
    return box ? [box] : []
  })
  const direct = directBoxes.length ? unionBounds(directBoxes) : undefined
  if (finiteBox(sceneBox) && finiteBox(direct)) {
    const covers = directBoxes.every(box => {
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2
      return cx >= sceneBox.x - 1 && cx <= sceneBox.x + sceneBox.width + 1 &&
        cy >= sceneBox.y - 1 && cy <= sceneBox.y + sceneBox.height + 1
    })
    if (covers) return sceneBox
  }
  return finiteBox(direct) ? direct : finiteBox(sceneBox) ? sceneBox : undefined
}
type PaintStack = 'fills' | 'strokes'
function nodeHasRemovablePaint(node: DesignNode | undefined, stack: PaintStack): boolean {
  return !!node && (node[stack].length > 0 || node.styleRefs?.[stack] !== undefined)
}
function clearPaintStack(node: DesignNode, stack: PaintStack) {
  node[stack] = []
  if (stack === 'fills') {
    clearWholeTextRunColor(node)
    delete node.sketchLayerStyleOverridden
  }
  if (node.styleRefs && Object.hasOwn(node.styleRefs, stack)) {
    delete node.styleRefs[stack]
    if (!Object.keys(node.styleRefs).length) delete node.styleRefs
  }
  if (!node.bindings) return
  for (const path of Object.keys(node.bindings)) {
    if (path === stack || path.startsWith(stack + '.')) delete node.bindings[path]
  }
  if (!Object.keys(node.bindings).length) delete node.bindings
}
export async function dispatchEditorCommand(editor: Editor, command: EditorCommand, options: {
  worldPoint?: Point
  pageId?: string
  nodeId?: string
  zoomAnchor?: Point
  shortcutProfile?: ShortcutProfile
  actionSource?: ActionSourceCode
  preserveFrameContents?: boolean
  fitAxes?: readonly ('width' | 'height')[]
} = {}): Promise<void> {
  const category = command === 'copy' ? CanvasAction.copy : command === 'cut' ? CanvasAction.cut : command.startsWith('paste') ? CanvasAction.paste : command === 'undo' ? CanvasAction.undo : command === 'redo' ? CanvasAction.redo : command === 'delete' ? CanvasAction.delete : command === 'duplicate' ? CanvasAction.duplicate : command === 'group' || command === 'frame-selection' || command === 'graphic-selection' ? CanvasAction.group : command === 'ungroup' ? CanvasAction.ungroup : command === 'select-all' ? CanvasAction.selectAll : CanvasAction.command
  const action = beginEditorAction(editor, category, options.actionSource ?? ActionSource.unknown, editorCommands.indexOf(command) + 1)
  try {
  const active = typeof document === 'undefined' ? null : document.activeElement
  const editable = editableOwnsKeyboard(active)
  const ownsPropertyPopover = ownedPropertyPreviewTarget(editor, active)
  const textCommand = command === 'select-all' ? 'selectAll' : (command === 'paste-in-place' || command === 'paste-over-selection') ? 'paste' : command
  // Resolve focused text ownership before any document boundary. Native menus
  // must still copy/paste/select invalid or composing drafts without committing
  // them. Read-only controls retain the native text command's own semantics.
  if (editable && ['undo','redo','cut','copy','paste','selectAll'].includes(textCommand) && !(command === 'undo' && ownsPropertyPopover)) {
    const native = desktopBridge()?.performTextCommand
    try {
      if (native) await native(textCommand as 'undo'|'redo'|'cut'|'copy'|'paste'|'selectAll')
      else if (!document.execCommand(textCommand)) { action.result(ActionOutcome.rejected, ActionReason.validation); return }
      action.result(ActionOutcome.observed, ActionReason.editingText)
    } catch (error) { action.result(ActionOutcome.rejected, ActionReason.validation); editor.notify(String(error)) }
    return
  }
  // Only this popover's first Undo and explicit tool activation may cross its
  // keyboard boundary. Unrelated text fields/dialogs cannot settle its draft.
  const propertyCommand = ownsPropertyPopover && (command === 'undo' || command.startsWith('set-tool-'))
  if ((editable || modalOwnsKeyboard(active)) && !propertyCommand) { action.result(ActionOutcome.blocked, ActionReason.wrongOwner); return }
  if (command === 'toggle-outlines') {
    if (!editor.interactionActive && interfacePreference.getSnapshot().uiMode === 'figma')
      editor.set({ outlines: !editor.state.outlines })
    return
  }
  if (command === 'undo' && editor.propertyPreviewActive) { editor.undo(); action.result(ActionOutcome.cancelled, ActionReason.escape); return }
  if (editor.propertyPreviewActive && !editor.settleOwnedPropertyPreview(command.startsWith('set-tool-') ? 'tool' : 'edit')) {
    action.result(ActionOutcome.blocked, ActionReason.validation); return
  }
  if (typeof command === 'string' && command.startsWith('set-tool-')) {
    const tool = toolForCommand(command)
    if (tool) {
      const session = editor.sessionGeneration, beforeTool = editor.state.tool
      await activateTool(editor,tool as import('./engine').Tool)
      action.result(session !== editor.sessionGeneration ? ActionOutcome.cancelled : editor.state.tool !== beforeTool ? ActionOutcome.observed : ActionOutcome.unchanged, session !== editor.sessionGeneration ? ActionReason.staleSession : ActionReason.none)
    }
    else {
      action.result(ActionOutcome.unsupported, ActionReason.unsupported)
      // Never let a decoded-but-unimplemented tool command pass silently.
      const entry = TOOL_COMMANDS.find((c) => c.id === command)
      editor.notify(
        entry ? `「${entry.label}」工具不可用：${unavailableReason(command)}` : `未知工具命令 ${command}`,
        { key: entry ? 'toolUnavailable' : 'unknownToolCommand', commandId: command },
      )
    }
    return
  }
  if (editor.state.busy) { action.result(ActionOutcome.blocked, ActionReason.busy); return }
  if (editor.interactionActive) { action.result(ActionOutcome.blocked, ActionReason.wrongOwner); editor.notify('请先结束拖动，或按 Esc 取消', { key: 'finishOrCancelDrag' }); return }
  if (!commitPendingEdits(editor)) { action.result(ActionOutcome.blocked, ActionReason.validation); return }
  const before = editor.state.doc, epoch = editor.sessionGeneration, version = editor.state.version, page = editor.state.page, selection = editor.state.selection.join('\n')
  const matches = () => editor.state.doc === before && !editor.state.busy && editor.sessionGeneration === epoch && editor.state.version === version && editor.state.page === page &&
    editor.state.selection.join('\n') === selection && !editor.interactionActive &&
    (typeof document === 'undefined' || (!editableOwnsKeyboard(document.activeElement) && !modalOwnsKeyboard(document.activeElement)))
  let invalidated = false
  const stopFence = editor.subscribe(() => { if (!matches()) invalidated = true })
  const current = () => !invalidated && matches()
  try {
    if (isSketchBooleanCommand(command)) {
      if (sketchSelectionCommands(editor).canCombine) await editor.geometry(sketchBooleanCommands[command].operation)
      return
    }
    if (isAlignmentCommand(command)) {
      const { axis, mode } = alignmentCommands[command]
      alignSelection(editor, axis, mode)
      return
    }
    if (isDimensionNudgeCommand(command)) {
      nudgeSelectionDimensions(editor, command, false, options.preserveFrameContents)
      return
    }
    if(['fill','stroke','effect','text','font','instance','properties','matching','inverse'].some(q=>command===`select-${q}`)){
      editor.select(querySelection(editor.state.doc,editor.state.page,editor.state.selection,command.slice(7) as SelectionQuery));return
    }
    const applyProperties=(text:string, includeCorners = true)=>{
      assertSize(text)
      const ids=editor.topSelection()
      if(!ids.length||lockedSelectionIds(editor).length)throw Error('请选择未锁定的粘贴目标')
      const value=readProperties(text)
      editor.change(includeCorners ? '粘贴属性' : '粘贴样式（保留圆角）', d => pasteProperties(d, ids, value, { includeCorners }))
    }
    if(['copy-properties','copy-fills','copy-strokes','copy-effects'].includes(command)){
      if(editor.state.selection.length!==1)throw Error('请选择一个来源图层')
      const kind:PropertyKind=command==='copy-properties'?'all':command.slice(5) as PropertyKind
      const text=copyProperties(editor.state.doc,editor.state.selection[0],kind);assertSize(text)
      const native=desktopBridge()?.clipboard
      if(native){const result=await native.write({text});if(result.status!=='ok')throw Error(result.status==='cancelled'?'复制已取消':result.message)}
      else if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(text)
      else throw Error('系统剪贴板不可用')
      action.result(ActionOutcome.observed);editor.notify('已复制属性', { key: 'propertiesCopied' });return
    }
    if(command==='paste-properties' || command==='paste-properties-no-corners'){
      const content=await readClipboard();if(!current())throw Error('读取剪贴板期间设计已变化，请重新粘贴')
      if(!content?.text)throw Error('剪贴板中没有属性');applyProperties(content.text, command === 'paste-properties');return
    }
    if (command === 'copy-as-png' || command === 'copy-as-svg') { await copySelectionAsset(editor,command==='copy-as-png'?'png':'svg'); action.result(ActionOutcome.observed); return }
    if (command === 'copy' || command === 'cut') {
      const forma = editor.exportClipboard(command === 'cut')
      if (!forma) return
      assertSize(forma)
      const native = desktopBridge()?.clipboard
      if (native) {
        const result = await native.write({ forma, text: editor.state.selection.map(id => { const n=editor.state.doc.nodes[id]; return n?.kind==='text'?n.text:n?.name||'' }).join('\n') })
        if (result.status !== 'ok') throw new Error(result.status === 'cancelled' ? '复制已取消' : result.message)
      } else await writeWebGraphClipboard(forma)
      action.result(command === 'copy' ? ActionOutcome.observed : ActionOutcome.unchanged)
      copiedPackets.set(editor, forma)
      if (command === 'cut') {
        if (!current()) throw new Error('复制期间选择已变化，原图层已保留')
        const version = editor.state.version
        editor.remove()
        action.result(editor.state.version !== version ? ActionOutcome.committed : ActionOutcome.unchanged)
      }
      return
    }
    if (command === 'paste' || command === 'paste-to-replace' || command === 'paste-in-place' || command === 'paste-over-selection' || command === 'paste-here') {
      if (command === 'paste-here' && (!options.worldPoint || !Number.isFinite(options.worldPoint.x) || !Number.isFinite(options.worldPoint.y))) throw new Error('粘贴位置无效')
      const content = await readClipboard()
      if (!current()) throw new Error('读取剪贴板期间设计已变化，请重新粘贴')
      let normalized: string | undefined
      if (content) {
        if(content.text?.startsWith(PROPERTY_PREFIX)){
          if (command === 'paste-over-selection') throw Error('覆盖粘贴需要图层、图片或文字内容，不支持属性剪贴板')
          if (command === 'paste-here') throw Error('粘贴到此处需要图层、图片或文字内容')
          applyProperties(content.text);return
        }
        const encoded = content.forma !== undefined ? content.forma : (content.text?.startsWith(TEXT_PREFIX) ? content.text.slice(TEXT_PREFIX.length) : undefined)
        if (encoded !== undefined) { if (!encoded) throw new Error('剪贴板图层数据为空'); assertSize(encoded); normalized = encoded }
        else if (content.svg || /^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(content.text || '')) {
          const { importSvg } = await import('./import-svg')
          const input = content.svg || content.text!; assertSize(input)
          if (!current()) { action.result(ActionOutcome.cancelled, ActionReason.superseded); return }
          const imported = importSvg(input, '粘贴的矢量')
          normalized = packet(imported.document)
        } else if (content.image) {
          assertSize(content.image)
          if (!/^data:image\/(png|jpeg|webp);base64,/.test(content.image)) throw new Error('剪贴板图片格式不支持')
          const image = new Image(); image.src = content.image; await image.decode()
          if (!current()) { action.result(ActionOutcome.cancelled, ActionReason.superseded); return }
          if (image.naturalWidth * image.naturalHeight > 16_777_216) throw new Error('剪贴板图片像素过大')
          const doc = blank('粘贴的图片'), n = node('rectangle', 0, 0, image.naturalWidth, image.naturalHeight)
          n.fills = [{ ...paint(), kind:'image', image:content.image, fit:'cover' }]
          doc.nodes[n.id] = n; doc.pages[0].children.push(n.id); normalized = packet(doc)
        } else if (content.text) {
          assertSize(content.text)
          const doc = blank('粘贴的文字'), n = node('text', 0, 0, 240, 32)
          n.text = content.text; doc.nodes[n.id] = n; doc.pages[0].children.push(n.id); normalized = packet(doc)
        } else return
      }
      if (command === 'paste-over-selection') {
        normalized ??= content ? undefined : copiedPackets.get(editor)
        if (!normalized) throw Error('剪贴板中没有可覆盖粘贴的图层；请先复制内容')
        const plan = planPasteOverSelection(before, page, editor.state.selection, normalized, options.shortcutProfile ?? shortcutPreference.getSnapshot())
        if (!current()) throw Error('读取剪贴板期间设计已变化，请重新粘贴')
        try { editor.change('覆盖粘贴', draft => applyPasteOverPlan(draft, before, plan.document), plan.selection) }
        finally { activateDocumentFonts(editor.state.doc) }
        return
      }
      if (normalized) editor.importClipboard(normalized)
      if(command==='paste' || command==='paste-to-replace') editor.pasteToSelection(command==='paste-to-replace')
      else editor.paste(command === 'paste-in-place', command === 'paste-here' ? options.worldPoint : undefined)
      return
    }
    if (command === 'eraser-or-prototype' || command === 'zoom-next-frame' || command === 'zoom-previous-frame' || command === 'next-page' || command === 'previous-page' || command === 'jump-to-node') {
      const host = typeof document === 'undefined' ? null : document.querySelector('[data-testid=canvas]')
      const size = { width: host?.clientWidth || 800, height: host?.clientHeight || 600 }
      if (command === 'eraser-or-prototype') {
        const tool = editor.state.tool
        if (tool === 'eraser') await activateTool(editor, 'vector')
        else if (['vector', 'pen', 'pencil', 'brush', 'marker'].includes(tool)) await activateTool(editor, 'eraser')
        else togglePrototypeTab()
      } else if (command === 'zoom-next-frame' || command === 'zoom-previous-frame') jumpFrame(editor, command === 'zoom-next-frame' ? 1 : -1, size)
      else if (command === 'next-page' || command === 'previous-page') jumpPage(editor, command === 'next-page' ? 1 : -1)
      else if (options.nodeId) jumpToNode(editor, options.nodeId, size)
      return
    }
    if (command === 'center-selection' || command === 'zoom-top-level-frame') {
      const box = command === 'center-selection' ? selectionCameraBox(editor) : selectedTopLevelFrameBounds(editor)
      if (!box) return
      const host = typeof document === 'undefined' ? null : document.querySelector('[data-testid=canvas]')
      const width = host?.clientWidth || 800, height = host?.clientHeight || 600
      const view = editor.flushPendingView()
      editor.set({ view: command === 'zoom-top-level-frame'
        ? fitSelectedBounds(box, { width, height }, 'sketch')
        : { ...view, x: width / 2 - (box.x + box.width / 2) * view.zoom, y: height / 2 - (box.y + box.height / 2) * view.zoom } })
      return
    }
    if (command.startsWith('zoom-')) {
      const host = document.querySelector('[data-testid=canvas]'), width = host?.clientWidth || 800, height = host?.clientHeight || 600
      // Land any parked wheel camera first: computing from the committed view
      // would let the next rAF commit roll this command's zoom back.
      const view = editor.flushPendingView()
      if (command === 'zoom-fit' || command === 'zoom-selection') {
        const entries = editor.entries().filter(e => command === 'zoom-fit' ? e.depth === 0 : editor.state.selection.includes(e.id))
        if (entries.length) {
          const box = unionBounds(entries.map(entry => entry.bounds))
          const size = { width, height }
          const view = command === 'zoom-selection'
            ? fitSelectedBounds(box, size, interfacePreference.getSnapshot().uiMode)
            : fitBounds(box, size)
          editor.set({ view })
        }
      } else {
        const anchor = options.zoomAnchor && Number.isFinite(options.zoomAnchor.x) && Number.isFinite(options.zoomAnchor.y) ? options.zoomAnchor : { x: width / 2, y: height / 2 }
        editor.set({ view: zoomAt(view, command === 'zoom-100' ? 1 : zoomStep(view.zoom, command === 'zoom-in' ? 1 : -1), anchor) })
      }
      return
    }
    switch (command) {
      case 'new-page': editor.addPage(); break
      case 'undo': editor.undo(); break
      case 'redo': editor.redo(); break
      case 'delete': editor.remove(); break
      case 'duplicate': editor.duplicate(); break
      case 'rename':
        if (editor.state.selection.length > 1) requestBatchRename(editor)
        else if (editor.state.selection.length === 1) editor.set({ renamingLayer: editor.state.selection[0] })
        break
      case 'fit-frame-content': {
        const ids = editor.topSelection()
        const frame = ids.length === 1 ? before.nodes[ids[0]] : undefined
        if (!frame || !canFitFrameContents(before, frame) || lockedSelectionIds(editor).length) break
        const axes = options.fitAxes ?? ['width', 'height']
        const sizing = { ...defaultSizing(), ...frame.sizing }
        const stack = frame.layout?.mode === 'horizontal' || frame.layout?.mode === 'vertical'
        for (const axis of axes) sizing[axis] = stack ? 'hug' : 'fixed'
        if (stack) {
          if (axes.every(axis => frame.sizing?.[axis] === 'hug')) break
          editor.change('调整尺寸以适应内容', draft => { draft.nodes[frame.id].sizing = sizing })
          break
        }
        const children = frame.children.filter(id => before.nodes[id].visible)
        const box = unionBounds(children.map(id => selectionParentBounds(before, id)))
        if (axes.some(axis => !(box[axis] > 0))) break
        const fitWidth = axes.includes('width'), fitHeight = axes.includes('height')
        const origin = apply(frame.transform, { x: fitWidth ? box.x : 0, y: fitHeight ? box.y : 0 })
        const patches = frameCropPatches(before, frame.id, {
          transform: [...frame.transform.slice(0, 4), origin.x, origin.y] as DesignNode['transform'],
          width: fitWidth ? box.width : frame.width, height: fitHeight ? box.height : frame.height,
          sizing,
        })
        editor.change('调整尺寸以适应内容', draft => {
          for (const [id, patch] of Object.entries(patches)) Object.assign(draft.nodes[id], patch)
        })
        break
      }
      case 'frame-selection': editor.group(false, undefined, 'frame'); break
      case 'graphic-selection': editor.group(false, undefined, 'graphic'); break
      case 'edit-frame-bounds': {
        const id = editableFrameCrop(editor)
        if (id && interfacePreference.getSnapshot().uiMode === 'sketch')
          editor.set({ tool: 'select', frameCrop: editor.state.frameCrop === id ? null : id })
        break
      }
      case 'auto-layout': editor.autoLayout(); break
      case 'remove-auto-layout': editor.autoLayout('none'); break
      case 'auto-pin-selection':
      case 'auto-pin-contents':
        if (interfacePreference.getSnapshot().uiMode === 'sketch')
          sketchAutoPin(editor, command === 'auto-pin-selection' ? 'selection' : 'contents')
        break
      case 'create-component':
        if (interfacePreference.getSnapshot().uiMode !== 'sketch' || requestSketchSymbolDialog(editor) === undefined)
          editor.createComponent()
        break
      case 'detach-instance': if (editor.state.selection.length === 1 && editor.state.doc.nodes[editor.state.selection[0]]?.instance) editor.detachInstance(); break
      case 'mask-selection': editor.group(true); break
      case 'convert-section': editor.update(editor.topSelection(), n => {
        if (n.kind !== 'frame' || n.instance || n.component || n.componentSet) return
        n.kind = 'section'
        delete n.graphic
        // Frame guides and scrolling are frame-only. Undo restores these
        // along with the original kind and preserves the child geometry.
        delete n.layoutGrid
        delete n.layoutGrids
        delete n.prototypeOverflow
      }, '转换为分区'); break
      case 'move-to-page': {
        if (!options.pageId || options.pageId === editor.state.page || !editor.state.doc.pages.some(p => p.id === options.pageId)) return
        const before = editor.state.doc
        editor.reparentMany(editor.topSelection(), options.pageId)
        if (editor.state.doc !== before) editor.clearSelection()
        break
      }
      case 'group': editor.group(); break
      case 'ungroup': editor.ungroup(); break
      case 'bring-to-front': editor.reorder('front'); break
      case 'send-to-back': editor.reorder('back'); break
      case 'bring-forward': editor.reorder('forward'); break
      case 'send-backward': editor.reorder('backward'); break
      case 'lock-selection': editor.update(editor.state.selection, { locked: true }, '切换锁定'); break
      case 'unlock-selection': editor.update(lockedSelectionIds(editor), { locked: false }, '切换锁定'); break
      case 'hide-selection': editor.update(editor.state.selection, { visible: false }, '切换可见性'); break
      case 'show-selection': editor.update(editor.state.selection, { visible: true }, '切换可见性'); break
      case 'convert-vector': editor.convert(); break
      case 'outline-stroke': await editor.geometry('outline'); action.result(ActionOutcome.observed, ActionReason.unobserved); break
      case 'swap-fills-and-strokes': {
        const { uiMode, locale } = interfacePreference.getSnapshot()
        if (uiMode === 'sketch') swapSelectionPaints(editor, locale === 'en'
          ? 'Some selected layers have fills or borders that cannot be swapped.'
          : '选区包含无法交换填充与描边的图层。')
        break
      }
      case 'toggle-sketch-borders':
      case 'toggle-sketch-fills':
        if (interfacePreference.getSnapshot().uiMode === 'sketch' &&
            ['select', 'multiselect', 'scale', 'zoom'].includes(editor.state.tool))
          toggleSketchPaintVisibility(editor, command === 'toggle-sketch-fills' ? 'fills' : 'strokes')
        break
      case 'remove-fill':
      case 'remove-stroke': {
        const fills = command === 'remove-fill'
        const stack = fills ? 'fills' : 'strokes'
        const selection = fills ? editor.state.selection : editor.topSelection()
        const ids = selection.filter(id => nodeHasRemovablePaint(editor.state.doc.nodes[id], stack))
        if (!ids.length) break
        if (fills) editor.updateProperties(ids, node => clearPaintStack(node, stack), '去掉填充')
        else editor.update(ids, node => clearPaintStack(node, stack), '去掉描边')
        break
      }
      case 'flatten': await editor.flattenSelection(); break
      case 'fit-pixel-bounds':
        if (interfacePreference.getSnapshot().uiMode === 'sketch') fitSelectionToPixelBounds(editor)
        break
      case 'round-to-pixel':
        if (interfacePreference.getSnapshot().uiMode === 'sketch') roundSelectionToPixels(editor)
        break
      case 'flip-horizontal':
      case 'flip-vertical': {
        const box = editor.selectionBounds()
        if (!box) break
        const horizontal = command === 'flip-horizontal'
        editor.transformSelection(horizontal ? [-1, 0, 0, 1, 2 * box.x + box.width, 0] : [1, 0, 0, -1, 0, 2 * box.y + box.height], horizontal ? '水平翻转' : '垂直翻转')
        break
      }
      case 'select-all': editor.select(selectAllCanvasIds(editor.state.doc, editor.state.page, editor.state.selection, options.shortcutProfile ?? shortcutPreference.getSnapshot())); break
    }
  } catch (error) { action.result(ActionOutcome.rejected, ActionReason.validation); editor.notify(error instanceof Error ? error.message : String(error)) }
  finally {
    stopFence()
    // Clipboard parsing/layout may temporarily install another document's fonts.
    // Restore the *current* document, including after asynchronous cancellation
    // or a successful paste which adopted additional embedded fonts.
    if (command === 'copy' || command === 'cut' || command.startsWith('paste')) activateDocumentFonts(editor.state.doc)
  }
  } finally { action.finish() }
}
