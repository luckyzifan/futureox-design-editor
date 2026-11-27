import { useInterfacePreferences } from './interface-preference'
import { canvasText } from './canvas-interface-messages'
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Lock } from 'lucide-react'
import type { Editor } from './engine'
import type { Point } from './model'
import { dispatchEditorCommand, type EditorCommand } from './editor-commands'
import { canvasContextItems, clampContextMenu, lockedSelectionIds, moveToPageIndex, pluginsMenuIndex, type ContextMenuOrigin } from './canvas-menu-model'
import { useShortcutProfile } from './shortcut-preference'
import { shortcutPlatform } from './shortcut-profiles'
import { desktopBridge } from './desktop'
import { userPages } from './fig-document'
import { pluginLaunchGrant, requestOpenPlugins } from './plugins/open-plugins'
import { commandSearchCopy } from './command-search'
import { requestCommandSearch } from './command-search-session'

export type CanvasLayerCandidate = { id: string; name: string; locked: boolean; hidden?: boolean }
export type CanvasContextMenuProps = {
  editor: Editor
  /** Browser client coordinates; the menu is portaled outside the canvas clip. */
  x: number
  y: number
  worldPoint: Point
  origin?: ContextMenuOrigin
  candidates?: CanvasLayerCandidate[]
  layerPickerOnly?: boolean
  onLayerPreview?: (id: string | null) => void
  onClose: () => void
  onEditText?: (id: string) => void
  onToggleUi?: () => void
}

type MenuBranch = 'layers' | 'pages' | 'plugins' | 'copy-as' | 'selection'
type OpenBranch = { name: MenuBranch; anchor: HTMLButtonElement; focus: boolean }

function menuButtons(menu: HTMLElement) {
  return [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')]
}

export function CanvasContextMenu({ editor, x, y, worldPoint, origin = editor.state.selection.length ? 'canvas' : 'empty-canvas',
  candidates = [], layerPickerOnly = false, onLayerPreview, onClose, onEditText, onToggleUi }: CanvasContextMenuProps) {
  const { locale, uiMode } = useInterfacePreferences(), text = canvasText[locale]
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot)
  const root = useRef<HTMLDivElement>(null), submenu = useRef<HTMLDivElement>(null), close = useRef(onClose)
  const previousFocus = useRef(document.activeElement), restoreFocus = useRef(false)
  const hoverClose = useRef<number | undefined>(undefined)
  close.current = onClose
  const [position, setPosition] = useState({ x, y })
  const [childPosition, setChildPosition] = useState<Point | null>(null)
  const [branch, setBranch] = useState<OpenBranch | null>(null)
  const [pluginRows, setPluginRows] = useState<{ grant: string; name: string }[]>([])
  const submenuId = useId()
  const context = useRef({ session: editor.sessionGeneration, page: state.page, version: state.version, selection: state.selection.join('\n') })
  const profile = useShortcutProfile()
  const figma = uiMode === 'figma', empty = origin === 'empty-canvas'
  const primaryBranch = layerPickerOnly ? 'layers' : figma ? null : branch?.name
  const flyout = figma && !layerPickerOnly ? branch : null
  const plugins = branch?.name === 'plugins'
  const labels: Record<MenuBranch, string> = {
    layers: text.selectLayer, pages: text.moveToPage, plugins: text.plugins, 'copy-as': text.copyAs, selection: text.selectSame,
  }
  const items = layerPickerOnly ? [] : canvasContextItems(editor, { profile, platform: shortcutPlatform(), desktop: !!desktopBridge() }, uiMode, origin)
  const parents = editor.parentMap(state.doc), locked = !layerPickerOnly && !!lockedSelectionIds(editor).length
  const visible = candidates.filter((candidate) => {
    let id: string | undefined = candidate.id
    if (!state.doc.nodes[id]) return false
    if (candidate.hidden && figma && state.outlines && state.outlineHiddenLayers !== false) return true
    while (id && state.doc.nodes[id]) { if (!state.doc.nodes[id].visible) return false; id = parents.get(id) }
    return true
  })
  const selected = state.selection.length === 1 ? state.doc.nodes[state.selection[0]] : undefined

  useLayoutEffect(() => {
    const menu = root.current
    if (!menu) return
    const next = clampContextMenu({ x, y }, menu.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight })
    setPosition((old) => old.x === next.x && old.y === next.y ? old : next)
  }, [x, y, primaryBranch, primaryBranch === 'plugins' ? pluginRows.length : 0, locale])
  useLayoutEffect(() => {
    const menu = root.current
    if (menu) (menuButtons(menu)[0] ?? menu).focus({ preventScroll: true })
  }, [x, y, primaryBranch])
  useLayoutEffect(() => {
    const menu = submenu.current, owner = root.current
    if (!flyout || !menu || !owner) return
    const item = flyout.anchor.getBoundingClientRect(), rect = owner.getBoundingClientRect(), size = menu.getBoundingClientRect()
    const room = { width: window.innerWidth, height: window.innerHeight }
    const left = rect.right + 4 + size.width <= room.width - 8 ? rect.right + 4 : rect.left - size.width - 4
    setChildPosition(clampContextMenu({ x: left, y: item.top - 5 }, size, room))
  }, [flyout, position, locale, plugins ? pluginRows.length : 0])
  useLayoutEffect(() => {
    if (flyout?.focus && submenu.current)
      (menuButtons(submenu.current)[0] ?? submenu.current).focus({ preventScroll: true })
  }, [flyout])
  useEffect(() => {
    const outside = (event: Event) => {
      const target = event.target
      if (target instanceof Node && !root.current?.contains(target) && !submenu.current?.contains(target)) close.current()
    }
    const dismiss = () => close.current()
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('wheel', outside, { capture: true, passive: true })
    window.addEventListener('blur', dismiss); window.addEventListener('resize', dismiss)
    return () => {
      window.clearTimeout(hoverClose.current)
      document.removeEventListener('pointerdown', outside, true); document.removeEventListener('wheel', outside, true)
      window.removeEventListener('blur', dismiss); window.removeEventListener('resize', dismiss)
      const previous = previousFocus.current
      if (restoreFocus.current && previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])
  useEffect(() => {
    if (!plugins) return
    let cancel = false
    const list = desktopBridge()?.plugins?.list
    if (!list) { setPluginRows([]); return }
    void list().then(result => {
      if (cancel || result.status !== 'ok') return
      setPluginRows(result.plugins.flatMap(plugin => {
        const grant = pluginLaunchGrant(plugin.grant)
        const name = plugin.displayName.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80)
        return grant && name ? [{ grant, name }] : []
      }).slice(0, 32))
    }).catch(() => { if (!cancel) setPluginRows([]) })
    return () => { cancel = true }
  }, [plugins])
  useEffect(() => {
    const opening = context.current
    if (opening.session !== editor.sessionGeneration || opening.page !== state.page || opening.version !== state.version || opening.selection !== state.selection.join('\n')) close.current()
  }, [editor, state.page, state.version, state.selection])

  function openPlugins(grant?: string) {
    restoreFocus.current = true
    close.current()
    const accepted = pluginLaunchGrant(grant)
    queueMicrotask(() => requestOpenPlugins(accepted))
  }
  function action(command: EditorCommand, pageId?: string) {
    const token = { session: editor.sessionGeneration, version: editor.state.version, page: editor.state.page, selection: editor.state.selection.join('\n') }
    close.current()
    queueMicrotask(() => {
      if (token.session !== editor.sessionGeneration || token.version !== editor.state.version || token.page !== editor.state.page || token.selection !== editor.state.selection.join('\n')) return
      document.querySelector<HTMLElement>('[data-testid="canvas"]')?.focus({ preventScroll: true })
      void dispatchEditorCommand(editor, command, { worldPoint: { ...worldPoint }, pageId })
    })
  }
  function openBranch(name: MenuBranch, anchor: HTMLButtonElement, focus: boolean) {
    window.clearTimeout(hoverClose.current)
    setBranch(current => current?.anchor === anchor && (!focus || current.focus) ? current : { name, anchor, focus })
  }
  function closeBranch(focus: boolean) {
    window.clearTimeout(hoverClose.current)
    if (focus && figma) branch?.anchor.focus({ preventScroll: true })
    setBranch(null)
  }
  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>, child = false) {
    event.stopPropagation()
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    const key = event.key
    if (event.repeat && ['Enter', ' ', 'Escape', 'Tab'].includes(key)) { event.preventDefault(); return }
    if ((key === 'ArrowLeft' || key === 'Escape' && child) && (child || !figma && !layerPickerOnly && branch)) {
      event.preventDefault()
      closeBranch(true)
      return
    }
    if (key === 'Escape' || key === 'Tab') {
      event.preventDefault(); restoreFocus.current = true; close.current()
      return
    }
    const active = document.activeElement as HTMLButtonElement | null
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) {
      event.preventDefault()
      const buttons = menuButtons(event.currentTarget), at = active ? buttons.indexOf(active) : -1
      const next = key === 'Home' ? 0 : key === 'End' ? buttons.length - 1 :
        at < 0 ? (key === 'ArrowDown' ? 0 : buttons.length - 1) : (at + (key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      buttons[next]?.focus({ preventScroll: true }); buttons[next]?.scrollIntoView({ block: 'nearest' })
    } else if (key === 'Enter' || key === ' ' || key === 'ArrowRight' && active?.dataset.menuGroup) {
      event.preventDefault()
      active?.click()
    }
  }

  function branchButton(name: MenuBranch, disabled = false) {
    const expanded = branch?.name === name
    return <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={expanded}
      aria-controls={expanded && figma ? submenuId : undefined} data-menu-group={name} disabled={disabled}
      data-layer-picker={name === 'layers' || undefined} data-page-picker={name === 'pages' || undefined}
      data-plugin-picker={name === 'plugins' || undefined}
      onPointerEnter={event => { if (figma && !disabled && event.pointerType === 'mouse') openBranch(name, event.currentTarget, false) }}
      onClick={event => openBranch(name, event.currentTarget, true)}>
      <span>{labels[name]}</span><ChevronRight size={14} aria-hidden="true" />
    </button>
  }
  const layerPicker = origin === 'canvas' && visible.length > 0 && <>
    <div role="separator" />
    {branchButton('layers')}
  </>
  const pluginPicker = branchButton('plugins', state.busy || editor.interactionActive)
  const pagePicker = (disabled: boolean) => branchButton('pages', disabled)
  function menuCommand(item: (typeof items)[number]) {
    return <button type="button" role="menuitem" key={item.command} aria-label={item.label} disabled={item.disabled}
      className={item.danger ? 'context-danger' : undefined}
      onPointerEnter={event => {
        if (!flyout || !root.current?.contains(event.currentTarget)) return
        window.clearTimeout(hoverClose.current)
        hoverClose.current = window.setTimeout(() => closeBranch(false), 120)
      }}
      onPointerMove={event => {
        if (!item.disabled) event.currentTarget.focus({ preventScroll: true })
      }}
      onClick={() => action(item.command)}>
      <span className="context-label">{item.label}</span>{item.shortcut && <kbd>{item.shortcut}</kbd>}
    </button>
  }
  function renderBranch(name: MenuBranch, back: boolean) {
    return <>
      {back && <>
        <button type="button" role="menuitem" className="context-back" onClick={() => closeBranch(true)}><ChevronLeft size={14} /><span>{labels[name]}</span></button>
        <div role="separator" />
      </>}
      {name === 'layers' ? visible.map(candidate => <button type="button" role="menuitem" key={candidate.id}
        aria-label={`${text.selectLayer} ${candidate.name}${candidate.locked ? text.lockedSuffix : ''}`}
        onPointerEnter={() => onLayerPreview?.(candidate.id)} onFocus={() => onLayerPreview?.(candidate.id)} onBlur={() => onLayerPreview?.(null)}
        onClick={() => { restoreFocus.current = true; editor.select([candidate.id]); close.current() }}>
        <span className="context-label">{candidate.name}</span>{candidate.locked && <Lock size={12} aria-hidden="true" />}
      </button>) : name === 'pages' ? userPages(state.doc).map(page =>
        <button type="button" role="menuitem" key={page.id} disabled={page.id === state.page} onClick={() => action('move-to-page', page.id)}>{page.name}</button>) :
        name === 'plugins' ? <>
          <button type="button" role="menuitem" onClick={() => openPlugins()}>{text.openPlugins}</button>
          {pluginRows.length > 0 && <div role="separator" />}
          {pluginRows.map(plugin => <button type="button" role="menuitem" key={plugin.grant} onClick={() => openPlugins(plugin.grant)}>
            <span className="context-label">{plugin.name}</span>
          </button>)}
        </> : items.filter(item => item.group === name).map(menuCommand)}
    </>
  }

  const visibleItems = items.filter((item, index) =>
    !['copy-as', 'selection'].includes(item.group) || !state.selection.length || items.findIndex(other => other.group === item.group) === index)
  const commands = visibleItems.map(item => item.command)
  const menuLabel = origin === 'layers' ? text.layerMenu : origin === 'inspector' ? text.layerActions : text.menu
  let previousGroup = ''
  return createPortal(<>
    <div ref={root} role="menu" aria-label={primaryBranch ? labels[primaryBranch] : menuLabel} className="canvas-context-menu"
      data-ui-mode={uiMode} style={{ left: position.x, top: position.y }} tabIndex={-1}
      onPointerDown={event => event.stopPropagation()} onPointerMove={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
      onPointerLeave={() => onLayerPreview?.(null)} onScroll={() => { if (flyout) closeBranch(false) }}
      onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation() }} onKeyDown={event => onMenuKeyDown(event)}>
      {primaryBranch ? renderBranch(primaryBranch, !layerPickerOnly) : <>
        {!empty && onEditText && selected?.kind === 'text' && !locked && <>
          <button type="button" role="menuitem" onClick={() => { close.current(); onEditText(selected.id) }}>{text.editText}</button>
          <div role="separator" />
        </>}
        {visibleItems.map((item, index) => {
          const separator = previousGroup && previousGroup !== item.group
          previousGroup = item.group
          if (state.selection.length && (item.group === 'copy-as' || item.group === 'selection'))
            return <div key={item.group} role="none">{separator && <div role="separator" />}{branchButton(item.group)}</div>
          const pageSlot = figma && !empty && index === moveToPageIndex(commands)
          const pluginSlot = figma && !empty && index === pluginsMenuIndex(commands)
          return <div key={item.command} role="none">
            {pageSlot && <>{layerPicker || <div role="separator" />}{pagePicker(state.busy || editor.interactionActive || locked || userPages(state.doc).length < 2)}</>}
            {pluginSlot && <><div role="separator" />{pluginPicker}</>}
            {separator && <div role="separator" />}
            {item.command === 'move-to-page' ? pagePicker(!!item.disabled) : menuCommand(item)}
          </div>
        })}
        {!figma && layerPicker}
        {empty && (figma || onToggleUi) && <>
          <div role="separator" />
          {onToggleUi && <button type="button" role="menuitem" onClick={() => { close.current(); onToggleUi() }}>{text.toggleUi}</button>}
          {figma && <>
            <button type="button" role="menuitem" onClick={() => { close.current(); requestCommandSearch(previousFocus.current) }}>{commandSearchCopy(uiMode, locale).label}</button>
            {pluginPicker}
          </>}
        </>}
      </>}
    </div>
    {flyout && <div ref={submenu} id={submenuId} role="menu" tabIndex={-1} aria-label={labels[flyout.name]}
      className="canvas-context-menu canvas-context-submenu" data-ui-mode={uiMode}
      style={{ left: childPosition?.x ?? -1000, top: childPosition?.y ?? -1000 }}
      onPointerEnter={() => window.clearTimeout(hoverClose.current)} onPointerLeave={() => onLayerPreview?.(null)}
      onPointerDown={event => event.stopPropagation()} onPointerMove={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation() }} onKeyDown={event => onMenuKeyDown(event, true)}>
      {renderBranch(flyout.name, false)}
    </div>}
  </>, document.body)
}

export default CanvasContextMenu
