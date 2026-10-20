import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Lock } from 'lucide-react'
import type { Editor } from './engine'
import type { Point } from './model'
import { dispatchEditorCommand, type EditorCommand } from './editor-commands'
import { canvasMenuItems, clampContextMenu, lockedSelectionIds } from './canvas-menu-model'
import { useShortcutProfile } from './shortcut-preference'
import { shortcutPlatform } from './shortcut-profiles'
import { desktopBridge } from './desktop'

export type CanvasLayerCandidate = { id: string; name: string; locked: boolean }
export type CanvasContextMenuProps = {
  editor: Editor
  /** Browser client coordinates; the menu is portaled outside the canvas clip. */
  x: number
  y: number
  worldPoint: Point
  candidates: CanvasLayerCandidate[]
  onClose: () => void
  onEditText?: (id: string) => void
}

export function CanvasContextMenu({ editor, x, y, worldPoint, candidates, onClose, onEditText }: CanvasContextMenuProps) {
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot)
  const root = useRef<HTMLDivElement>(null), close = useRef(onClose)
  const previousFocus = useRef(document.activeElement), restoreFocus = useRef(false)
  close.current = onClose
  const [layers, setLayers] = useState(false), [position, setPosition] = useState({ x, y })
  const [pages, setPages] = useState(false),[group,setGroup]=useState<string|null>(null)
  const groupName=(id:string)=>id==='copy-as'?'复制／粘贴为':'选择相同'
  const context = useRef({ session: editor.sessionGeneration, page: state.page, version: state.version, selection: state.selection.join('\n') })
  const profile = useShortcutProfile()
  const items = canvasMenuItems(editor, { profile, platform: shortcutPlatform(), desktop: !!desktopBridge() }), parents = editor.parentMap(state.doc)
  const visible = candidates.filter((candidate) => {
    let id: string | undefined = candidate.id
    if (!state.doc.nodes[id]) return false
    while (id && state.doc.nodes[id]) { if (!state.doc.nodes[id].visible) return false; id = parents.get(id) }
    return true
  })
  const selected = state.selection.length === 1 ? state.doc.nodes[state.selection[0]] : undefined
  useLayoutEffect(() => {
    const menu = root.current
    if (!menu) return
    const box = menu.getBoundingClientRect()
    const next = clampContextMenu({ x, y }, box, { width: window.innerWidth, height: window.innerHeight })
    setPosition((old) => old.x === next.x && old.y === next.y ? old : next)
    ;(menu.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') || menu).focus({ preventScroll: true })
  }, [x, y, layers, pages, group])
  useEffect(() => {
    const outside = (event: Event) => { if (event.target instanceof Node && !root.current?.contains(event.target)) close.current() }
    const dismiss = () => close.current()
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('wheel', outside, { capture: true, passive: true })
    window.addEventListener('blur', dismiss); window.addEventListener('resize', dismiss)
    return () => {
      document.removeEventListener('pointerdown', outside, true); document.removeEventListener('wheel', outside, true)
      window.removeEventListener('blur', dismiss); window.removeEventListener('resize', dismiss)
      const previous = previousFocus.current
      if (restoreFocus.current && previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])
  useEffect(() => {
    const opening = context.current
    if (opening.session !== editor.sessionGeneration || opening.page !== state.page || opening.version !== state.version || opening.selection !== state.selection.join('\n')) close.current()
  }, [editor, state.page, state.version, state.selection])
  function action(command: EditorCommand, pageId?: string) {
    const token = { session: editor.sessionGeneration, version: editor.state.version, page: editor.state.page, selection: editor.state.selection.join('\n') }
    close.current()
    queueMicrotask(() => {
      if (token.session !== editor.sessionGeneration || token.version !== editor.state.version || token.page !== editor.state.page || token.selection !== editor.state.selection.join('\n')) return
      document.querySelector<HTMLElement>('[data-testid="canvas"]')?.focus({ preventScroll: true })
      void dispatchEditorCommand(editor, command, { worldPoint: { ...worldPoint }, pageId })
    })
  }
  let previousGroup = ''
  return createPortal(<div ref={root} role="menu" aria-label={layers ? '选择图层' : pages ? '移动到页面' : group?groupName(group):'画布右键菜单'} className="canvas-context-menu"
    style={{ left: position.x, top: position.y }} tabIndex={-1}
    onPointerDown={(event) => event.stopPropagation()} onPointerMove={(event) => event.stopPropagation()} onPointerUp={(event) => event.stopPropagation()}
    onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}
    onContextMenu={(event) => { event.preventDefault(); event.stopPropagation() }}
    onKeyDown={(event) => {
      event.stopPropagation()
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
      if (event.repeat && ['Enter', ' ', 'Escape', 'Tab'].includes(event.key)) { event.preventDefault(); return }
      if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); restoreFocus.current = true; close.current(); return }
      if (event.key === 'ArrowLeft' && (layers || pages || group)) { event.preventDefault(); setLayers(false); setPages(false);setGroup(null); return }
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')]
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
          (Math.max(at, 0) + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        buttons[next]?.focus({ preventScroll: true }); buttons[next]?.scrollIntoView({ block: 'nearest' })
      }
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); (document.activeElement as HTMLButtonElement)?.click?.() }
      if(event.key==='ArrowRight'&&(document.activeElement as HTMLElement)?.dataset.menuGroup){event.preventDefault();setGroup((document.activeElement as HTMLElement).dataset.menuGroup!)}
      if (event.key === 'ArrowRight' && (document.activeElement as HTMLElement)?.dataset.layerPicker === 'true') { event.preventDefault(); setLayers(true) }
      if (event.key === 'ArrowRight' && (document.activeElement as HTMLElement)?.dataset.pagePicker === 'true') { event.preventDefault(); setPages(true) }
    }}>
    {layers ? <>
      <button type="button" role="menuitem" className="context-back" onClick={() => setLayers(false)}><ChevronLeft size={14} /><span>选择图层</span></button>
      <div role="separator" />
      {visible.map((candidate) => <button type="button" role="menuitem" key={candidate.id} aria-label={`选择图层 ${candidate.name}${candidate.locked ? '（已锁定）' : ''}`}
        onClick={() => { restoreFocus.current = true; editor.select([candidate.id]); close.current() }}><span className="context-label">{candidate.name}</span>{candidate.locked && <Lock size={12} aria-hidden="true" />}</button>)}
    </> : pages ? <>
      <button type="button" role="menuitem" className="context-back" onClick={() => setPages(false)}><ChevronLeft size={14} /><span>移动到页面</span></button>
      <div role="separator" />
      {state.doc.pages.map(page => <button type="button" role="menuitem" key={page.id} disabled={page.id === state.page} onClick={() => action('move-to-page', page.id)}>{page.name}</button>)}
    </> : group ? <>
      <button type="button" role="menuitem" className="context-back" onClick={()=>setGroup(null)}><ChevronLeft size={14}/><span>{groupName(group)}</span></button><div role="separator"/>
      {items.filter(item=>item.group===group).map(item=><button type="button" role="menuitem" key={item.command} disabled={item.disabled} onClick={()=>action(item.command)}><span className="context-label">{item.label}</span>{item.shortcut&&<kbd>{item.shortcut}</kbd>}</button>)}
    </> : <>
      {visible.length > 0 && <><button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={false} data-layer-picker="true" onClick={() => setLayers(true)}><span>选择图层</span><ChevronRight size={14} /></button><div role="separator" /></>}
      {onEditText && selected?.kind === 'text' && !lockedSelectionIds(editor).length && <><button type="button" role="menuitem" onClick={() => { close.current(); queueMicrotask(() => onEditText(selected.id)) }}>编辑文字</button><div role="separator" /></>}
      {!!state.selection.length && <><button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={false} data-page-picker="true" disabled={state.busy || editor.interactionActive || !!lockedSelectionIds(editor).length || state.doc.pages.length < 2} onClick={() => setPages(true)}><span>移动到页面</span><ChevronRight size={14} /></button><div role="separator" /></>}
      {items.filter((item,index)=>!['copy-as','selection'].includes(item.group)||!state.selection.length||items.findIndex(other=>other.group===item.group)===index).map((item) => {
        if(state.selection.length&&['copy-as','selection'].includes(item.group))return <div key={item.group} role="none"><div role="separator"/><button type="button" role="menuitem" aria-haspopup="menu" data-menu-group={item.group} onClick={()=>setGroup(item.group)}><span>{groupName(item.group)}</span><ChevronRight size={14}/></button></div>
        const separator = previousGroup && previousGroup !== item.group
        previousGroup = item.group
        return <div key={item.command} role="none">
          {separator && <div role="separator" />}
          <button type="button" role="menuitem" aria-label={item.label} disabled={item.disabled} className={item.danger ? 'context-danger' : undefined}
            onPointerMove={(event) => { if (!item.disabled) event.currentTarget.focus({ preventScroll: true }) }}
            onClick={() => action(item.command)}><span className="context-label">{item.label}</span>{item.shortcut && <kbd>{item.shortcut}</kbd>}</button>
        </div>
      })}
    </>}
  </div>, document.body)
}

export default CanvasContextMenu
