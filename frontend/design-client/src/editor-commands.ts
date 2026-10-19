import {PROPERTY_PREFIX,copyProperties,readProperties,pasteProperties,type PropertyKind} from './property-clipboard'
import {activateTool} from './tool-activation'
import { copySelectionAsset } from './clipboard-export'
import { modalOwnsKeyboard, editableOwnsKeyboard } from './modal-keyboard'
import type { Editor } from './engine'
import { desktopBridge, type DesktopClipboard } from './desktop'
import { commitPendingEdits } from './pending-edits'
import { blank, node, paint, type DesignDocument, type Point } from './model'
import { lockedSelectionIds } from './canvas-menu-model'
import { fitBounds, zoomAt, zoomStep } from './canvas-camera'
import { unionBounds } from './geometry'
import {querySelection,type SelectionQuery} from './selection-queries'
import { dimensionNudgeCommands, isDimensionNudgeCommand, nudgeSelectionDimensions, selectAllCanvasIds, type DimensionNudgeCommand } from './canvas-workflow-shortcuts'
import { activateDocumentFonts } from './kernel/picking'
import { applyPasteOverPlan, planPasteOverSelection } from './paste-over-selection'
import { shortcutPreference } from './shortcut-preference'
import type { ShortcutProfile } from './shortcut-profiles'

import { toolForCommand, unavailableReason, TOOL_COMMANDS } from './tool-registry'

export type SetToolCommand = `set-tool-${string}`
export type EditorCommand = DimensionNudgeCommand | 'copy-properties'|'paste-properties'|'copy-fills'|'copy-strokes'|'copy-effects' | SetToolCommand | `select-${SelectionQuery}` | 'rename' | 'frame-selection' | 'auto-layout' | 'remove-auto-layout' | 'create-component' | 'mask-selection' | 'convert-section' | 'move-to-page' | 'copy-as-png' | 'copy-as-svg' | 'undo' | 'redo' | 'copy' | 'cut' | 'paste' | 'paste-to-replace' | 'paste-in-place' | 'paste-over-selection' | 'paste-here' | 'delete' | 'duplicate' | 'group' | 'ungroup' | 'select-all' | 'zoom-in' | 'zoom-out' | 'zoom-100' | 'zoom-fit' | 'zoom-selection' | 'center-selection' | 'flip-horizontal' | 'flip-vertical' | 'bring-to-front' | 'send-to-back' | 'bring-forward' | 'send-backward' | 'lock-selection' | 'unlock-selection' | 'hide-selection' | 'show-selection' | 'outline-stroke' | 'convert-vector'
export const editorCommands: readonly EditorCommand[] = [...dimensionNudgeCommands,'copy-properties','paste-properties','copy-fills','copy-strokes','copy-effects',...(['fill','stroke','effect','text','font','instance','properties','matching','inverse'] as const).map(q=>`select-${q}` as const), ...TOOL_COMMANDS.map((c) => `set-tool-${c.id.slice(9)}` as const).filter((v, i, a) => a.indexOf(v) === i), 'rename','frame-selection','auto-layout','remove-auto-layout','create-component','mask-selection','convert-section','move-to-page','copy-as-png','copy-as-svg','undo','redo','copy','cut','paste','paste-to-replace','paste-in-place','paste-over-selection','paste-here','delete','duplicate','group','ungroup','select-all','zoom-in','zoom-out','zoom-100','zoom-fit','zoom-selection','center-selection','flip-horizontal','flip-vertical','bring-to-front','send-to-back','bring-forward','send-backward','lock-selection','unlock-selection','hide-selection','show-selection','outline-stroke','convert-vector']
const MAX_CLIPBOARD_BYTES = 32 * 1024 * 1024
const copiedPackets = new WeakMap<Editor, string>()
const TEXT_PREFIX = 'FORMA-NODES-V1\n'
function assertSize(value: string) { if (new TextEncoder().encode(value).byteLength > MAX_CLIPBOARD_BYTES) throw new Error('剪贴板内容超过 32 MiB') }
function packet(document: DesignDocument) { return JSON.stringify({ format:'forma-nodes', version:1, document, roots:document.pages[0].children }) }
async function readClipboard(): Promise<DesktopClipboard | null> {
  const native = desktopBridge()?.clipboard
  if (native) {
    const result = await native.read()
    if (result.status !== 'ok') throw new Error(result.status === 'cancelled' ? '读取剪贴板已取消' : result.message)
    return result
  }
  if (!navigator.clipboard?.readText) return null
  return { text: await navigator.clipboard.readText() }
}
export async function dispatchEditorCommand(editor: Editor, command: EditorCommand, options: { worldPoint?: Point; pageId?: string; zoomAnchor?: Point; shortcutProfile?: ShortcutProfile } = {}): Promise<void> {
  const active = typeof document === 'undefined' ? null : document.activeElement
  const editable = editableOwnsKeyboard(active)
  // Native menu accelerators arrive without a DOM KeyboardEvent. Preserve the
  // focused text control and modal ownership at the shared command boundary too.
  if ((editable && !['undo', 'redo', 'cut', 'copy', 'paste', 'paste-in-place', 'paste-over-selection', 'select-all'].includes(command)) || (!editable && modalOwnsKeyboard(active))) return
  if (typeof command === 'string' && command.startsWith('set-tool-')) {
    const tool = toolForCommand(command)
    if (tool) await activateTool(editor,tool as import('./engine').Tool)
    else {
      // Never let a decoded-but-unimplemented tool command pass silently.
      const entry = TOOL_COMMANDS.find((c) => c.id === command)
      editor.notify(
        entry ? `「${entry.label}」工具不可用：${unavailableReason(command)}` : `未知工具命令 ${command}`,
      )
    }
    return
  }
  const textCommand = command === 'select-all' ? 'selectAll' : (command === 'paste-in-place' || command === 'paste-over-selection') ? 'paste' : command
  if (editable && ['undo','redo','cut','copy','paste','selectAll'].includes(textCommand)) {
    const native = desktopBridge()?.performTextCommand
    try {
      if (native) await native(textCommand as 'undo'|'redo'|'cut'|'copy'|'paste'|'selectAll')
      else document.execCommand(textCommand)
    } catch (error) { editor.notify(String(error)) }
    return
  }
  if (editor.state.busy) return
  if (editor.interactionActive) { editor.notify('请先结束拖动，或按 Esc 取消'); return }
  if (!commitPendingEdits(editor)) return
  const before = editor.state.doc, epoch = editor.sessionGeneration, version = editor.state.version, page = editor.state.page, selection = editor.state.selection.join('\n')
  const current = () => editor.state.doc === before && !editor.state.busy && editor.sessionGeneration === epoch && editor.state.version === version && editor.state.page === page &&
    editor.state.selection.join('\n') === selection && !editor.interactionActive &&
    (typeof document === 'undefined' || (!editableOwnsKeyboard(document.activeElement) && !modalOwnsKeyboard(document.activeElement)))
  try {
    if (isDimensionNudgeCommand(command)) { nudgeSelectionDimensions(editor, command); return }
    if(['fill','stroke','effect','text','font','instance','properties','matching','inverse'].some(q=>command===`select-${q}`)){
      editor.select(querySelection(editor.state.doc,editor.state.page,editor.state.selection,command.slice(7) as SelectionQuery));return
    }
    const applyProperties=(text:string)=>{
      const ids=editor.topSelection()
      if(!ids.length||lockedSelectionIds(editor).length)throw Error('请选择未锁定的粘贴目标')
      const value=readProperties(text)
      editor.change('粘贴属性',d=>pasteProperties(d,ids,value))
    }
    if(['copy-properties','copy-fills','copy-strokes','copy-effects'].includes(command)){
      if(editor.state.selection.length!==1)throw Error('请选择一个来源图层')
      const kind:PropertyKind=command==='copy-properties'?'all':command.slice(5) as PropertyKind
      const text=copyProperties(editor.state.doc,editor.state.selection[0],kind);assertSize(text)
      const native=desktopBridge()?.clipboard
      if(native){const result=await native.write({text});if(result.status!=='ok')throw Error(result.status==='cancelled'?'复制已取消':result.message)}
      else if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(text)
      else throw Error('系统剪贴板不可用')
      editor.notify('已复制属性');return
    }
    if(command==='paste-properties'){
      const content=await readClipboard();if(!current())throw Error('读取剪贴板期间设计已变化，请重新粘贴')
      if(!content?.text)throw Error('剪贴板中没有属性');applyProperties(content.text);return
    }
    if (command === 'copy-as-png' || command === 'copy-as-svg') { await copySelectionAsset(editor,command==='copy-as-png'?'png':'svg'); return }
    if (command === 'copy' || command === 'cut') {
      const forma = editor.exportClipboard(command === 'cut')
      if (!forma) return
      assertSize(forma)
      const native = desktopBridge()?.clipboard
      if (native) {
        const result = await native.write({ forma, text: editor.state.selection.map(id => { const n=editor.state.doc.nodes[id]; return n?.kind==='text'?n.text:n?.name||'' }).join('\n') })
        if (result.status !== 'ok') throw new Error(result.status === 'cancelled' ? '复制已取消' : result.message)
      } else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(TEXT_PREFIX + forma)
      copiedPackets.set(editor, forma)
      if (command === 'cut') {
        if (!current()) throw new Error('复制期间选择已变化，原图层已保留')
        editor.remove()
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
          applyProperties(content.text);return
        }
        const encoded = content.forma || (content.text?.startsWith(TEXT_PREFIX) ? content.text.slice(TEXT_PREFIX.length) : undefined)
        if (encoded) normalized = encoded
        else if (content.svg || /^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(content.text || '')) {
          const { importSvg } = await import('./import-svg')
          const input = content.svg || content.text!; assertSize(input)
          if (!current()) return
          const imported = importSvg(input, '粘贴的矢量')
          normalized = packet(imported.document)
        } else if (content.image) {
          assertSize(content.image)
          if (!/^data:image\/(png|jpeg|webp);base64,/.test(content.image)) throw new Error('剪贴板图片格式不支持')
          const image = new Image(); image.src = content.image; await image.decode()
          if (!current()) return
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
    if (command === 'center-selection') {
      const selected = new Set(editor.state.selection)
      const entries = editor.entries().filter(entry => selected.has(entry.id))
      if (!entries.length) return
      const box = unionBounds(entries.map(entry => entry.bounds))
      if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) return
      const host = typeof document === 'undefined' ? null : document.querySelector('[data-testid=canvas]')
      const width = host?.clientWidth || 800, height = host?.clientHeight || 600
      const view = editor.flushPendingView()
      editor.set({ view: { ...view, x: width / 2 - (box.x + box.width / 2) * view.zoom, y: height / 2 - (box.y + box.height / 2) * view.zoom } })
      return
    }
    if (command.startsWith('zoom-')) {
      const host = document.querySelector('[data-testid=canvas]'), width = host?.clientWidth || 800, height = host?.clientHeight || 600
      // Land any parked wheel camera first: computing from the committed view
      // would let the next rAF commit roll this command's zoom back.
      const view = editor.flushPendingView()
      if (command === 'zoom-fit' || command === 'zoom-selection') {
        const entries = editor.entries().filter(e => command === 'zoom-fit' ? e.depth === 0 : editor.state.selection.includes(e.id))
        if (entries.length) editor.set({ view: fitBounds(unionBounds(entries.map(e => e.bounds)), {width,height}) })
      } else {
        const anchor = options.zoomAnchor && Number.isFinite(options.zoomAnchor.x) && Number.isFinite(options.zoomAnchor.y) ? options.zoomAnchor : { x: width / 2, y: height / 2 }
        editor.set({ view: zoomAt(view, command === 'zoom-100' ? 1 : zoomStep(view.zoom, command === 'zoom-in' ? 1 : -1), anchor) })
      }
      return
    }
    switch (command) {
      case 'undo': editor.undo(); break
      case 'redo': editor.redo(); break
      case 'delete': editor.remove(); break
      case 'duplicate': editor.duplicate(); break
      case 'rename': if (editor.state.selection.length === 1) editor.set({ renamingLayer: editor.state.selection[0] }); break
      case 'frame-selection': editor.group(false, undefined, 'frame'); break
      case 'auto-layout': editor.autoLayout(); break
      case 'remove-auto-layout': editor.autoLayout('none'); break
      case 'create-component': editor.createComponent(); break
      case 'mask-selection': editor.group(true); break
      case 'convert-section': editor.update(editor.topSelection(), n => { if (n.kind === 'frame' && !n.instance && !n.component && !n.componentSet) n.kind = 'section' }, '转换为分区'); break
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
      case 'outline-stroke': await editor.geometry('outline'); break
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
  } catch (error) { editor.notify(error instanceof Error ? error.message : String(error)) }
}
