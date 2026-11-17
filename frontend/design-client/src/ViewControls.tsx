import { dispatchEditorCommand } from './editor-commands'
import { desktopBridge } from './desktop'
import { shortcutLabel, shortcutPlatform } from './shortcut-profiles'
import { useShortcutProfile } from './shortcut-preference'
import { useInterfacePreferences, useInterfaceText } from './interface-preference'
import type { Editor } from './engine'
import { zoomAt, zoomStep, MIN_CANVAS_ZOOM, MAX_CANVAS_ZOOM } from './canvas-camera'
import { NumberField } from './fields'
import { PendingEditContext } from './pending-edit-context'
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'

type PixelPreviewLevel = 0 | 1 | 2

/** The view menu scrolls, so the flyout is portaled. Choosing a level closes
 * both menus and returns focus to the zoom summary, matching the desktop menu. */
function PixelPreviewSubmenu({
  label, offLabel, value, onChoose, onDismiss, panelRef, closeRef,
}: {
  label: string
  offLabel: string
  value: PixelPreviewLevel
  onChoose: (value: PixelPreviewLevel) => void
  onDismiss: () => void
  panelRef: { current: HTMLElement | null }
  closeRef: { current: () => void }
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const pendingFocus = useRef(false)
  const [open, setOpen] = useState(false)
  const id = useId()
  const options = [
    { value: 0 as const, label: offLabel },
    { value: 1 as const, label: '1×' },
    { value: 2 as const, label: '2×' },
  ]
  closeRef.current = () => setOpen(false)
  const focusChecked = () => {
    const checked = panel.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')
    const first = panel.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]')
    ;(checked ?? first)?.focus()
  }
  const openSubmenu = (focus: boolean) => {
    pendingFocus.current = focus
    if (open) { if (focus) focusChecked(); return }
    setOpen(true)
  }
  const leaveSubmenu = () => { setOpen(false); trigger.current?.focus() }
  const inside = (target: EventTarget | null) => target instanceof Node &&
    (!!trigger.current?.contains(target) || !!panel.current?.contains(target))
  const place = () => {
    if (!trigger.current || !panel.current) return
    const anchor = trigger.current.getBoundingClientRect()
    const menu = panel.current
    const theme = trigger.current.ownerDocument.defaultView?.getComputedStyle(trigger.current)
    if (theme) for (const key of ['--workspace-panel', '--workspace-text', '--workspace-border', '--workspace-hover', '--workspace-accent', '--workspace-selected']) {
      const next = theme.getPropertyValue(key)
      if (next) menu.style.setProperty(key, next)
    }
    const width = menu.offsetWidth || 168
    const height = menu.offsetHeight || 120
    const margin = 8
    const left = anchor.left >= window.innerWidth - anchor.right ? anchor.left - width + 8 : anchor.right - 8
    menu.style.left = `${Math.max(margin, Math.min(left, window.innerWidth - width - margin))}px`
    menu.style.top = `${Math.max(margin, Math.min(anchor.top, window.innerHeight - height - margin))}px`
  }
  useLayoutEffect(() => {
    if (!open) return
    place()
    if (!pendingFocus.current) return
    pendingFocus.current = false
    focusChecked()
  }, [open, value])
  useEffect(() => {
    const scroller = trigger.current?.closest('.view-menu-body')
    if (!open || !scroller) return
    scroller.addEventListener('scroll', place, { passive: true })
    window.addEventListener('resize', place)
    return () => {
      scroller.removeEventListener('scroll', place)
      window.removeEventListener('resize', place)
    }
  }, [open])
  return <div className="view-pixel-preview">
    <button ref={trigger} type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={(event) => { event.stopPropagation(); openSubmenu(true) }}
      onPointerEnter={() => openSubmenu(false)}
      onPointerLeave={(event) => { if (!inside(event.relatedTarget) && !panel.current?.contains(document.activeElement)) setOpen(false) }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
        if (event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ') {
          event.preventDefault(); event.stopPropagation(); openSubmenu(true)
        } else if (event.key === 'ArrowLeft' && open) {
          event.preventDefault(); event.stopPropagation(); setOpen(false)
        }
      }}>
      <span>{label}</span><span aria-hidden="true">›</span>
    </button>
    {open && createPortal(<div ref={(node) => { panel.current = node; panelRef.current = node }} id={id} role="menu" aria-label={label}
      className="view-submenu" tabIndex={-1}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerLeave={(event) => { if (!inside(event.relatedTarget) && !panel.current?.contains(document.activeElement)) setOpen(false) }}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
        if (event.repeat && (event.key === 'Enter' || event.key === ' ' || event.key === 'Escape')) { event.preventDefault(); return }
        const items = [...(panel.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])]
        if (event.key === 'ArrowLeft' || event.key === 'Tab') { event.preventDefault(); leaveSubmenu(); return }
        if (!items.length) return
        if (event.key === 'Escape') { event.preventDefault(); onDismiss(); return }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
          event.preventDefault()
          const at = items.indexOf(document.activeElement as HTMLButtonElement)
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
            : (Math.max(at, 0) + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
          items[next]?.focus()
          return
        }
        if (event.key === 'ArrowRight') { event.preventDefault(); return }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          const current = document.activeElement as HTMLButtonElement
          if (items.includes(current)) current.click()
        }
      }}>
      {options.map(option => <button type="button" role="menuitemradio" tabIndex={-1} key={option.value}
        aria-label={option.label} aria-checked={value === option.value}
        onClick={() => onChoose(option.value)}>
        <span className="view-submenu-mark" aria-hidden="true">{value === option.value ? '✓' : ''}</span>
        <span>{option.label}</span>
      </button>)}
    </div>, document.body)}
  </div>
}

export function ViewControls({
  editor,
  size,
  fit,
  compact = false,
  outlineAvailable = true,
}: {
  editor: Editor
  compact?: boolean
  outlineAvailable?: boolean
  size: { width: number; height: number }
  fit: (selection?: boolean) => void
}) {
  const text = useInterfaceText()
  const s = editor.state
  const { locale, uiMode } = useInterfacePreferences()
  const profile = useShortcutProfile()
  const shortcut = { profile, platform: shortcutPlatform(), desktop: !!desktopBridge() }
  const sketch = uiMode === 'sketch'
  const label = (zh: string, en: string) => locale === 'en' ? en : zh
  const centerKey = shortcutLabel('center-selection', shortcut)
  const liveZoom = useSyncExternalStore(editor.subscribeCamera, () => editor.effectiveView().zoom, () => editor.state.view.zoom)
  const zoomPercentage = sketch ? Math.floor(liveZoom * 100 + 1e-9) : Number((liveZoom * 100).toFixed(1))
  const menu = useRef<HTMLDetailsElement>(null)
  const pixelPanel = useRef<HTMLElement | null>(null)
  const closePixel = useRef<() => void>(() => {})
  const zoomSummary = () => menu.current?.querySelector<HTMLElement>(':scope > summary')
  const closeMenu = () => { closePixel.current(); if (menu.current) menu.current.open = false }
  const dismissViewMenu = () => { closeMenu(); zoomSummary()?.focus() }
  useEffect(() => {
    const dismiss = (event: Event) => {
      const target = event.target as Node
      if (menu.current && !menu.current.contains(target) && !pixelPanel.current?.contains(target)) closeMenu()
    }
    const blur = () => closeMenu()
    document.addEventListener('pointerdown', dismiss, true); window.addEventListener('blur', blur)
    return () => { document.removeEventListener('pointerdown', dismiss, true); window.removeEventListener('blur', blur) }
  }, [])
  const zoom = (value: number) => {
    // Parked wheel cameras must land before button math: otherwise the next
    // rAF commit rolls the button's zoom back to the pre-click camera.
    const view = editor.flushPendingView()
    editor.set({ view: zoomAt(view, value, { x: size.width / 2, y: size.height / 2 }) })
  }
  const choosePreview = (value: PixelPreviewLevel) => {
    if (editor.state.pixelPreview !== value)
      editor.set({ pixelPreview: value, ...(value ? { lastPixelPreview: value } : {}) })
    dismissViewMenu()
  }
  const zoomSteps = compact && <div className="zoom-steps">
    {(sketch ? [-1, 1] : [1, -1]).map(direction => {
      const title = direction === 1 ? text.zoomIn : text.zoomOut
      return <button type="button" key={direction} title={title}
        onClick={() => zoom(zoomStep(editor.effectiveView().zoom, direction === 1 ? 1 : -1))}>
        {sketch ? direction === 1 ? '＋' : '−' : title}
      </button>
    })}
  </div>
  const fitButtons = <>
    <button type="button" onClick={() => { fit(); closeMenu() }}>{text.fitAll}　{shortcutLabel('zoom-fit', shortcut)}</button>
    {(sketch || !!s.selection.length) && <button type="button" onClick={() => { fit(true); closeMenu() }}>
      {text.fitSelection}　{shortcutLabel('zoom-selection', shortcut)}
    </button>}
  </>
  return (
    <div
      className={`canvas-controls ${compact ? 'compact-controls' : ''}`}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape' && menu.current?.open) { dismissViewMenu(); e.preventDefault() } }}
    >
      {!compact && <button type="button" title={text.zoomOut} onClick={() => zoom(zoomStep(editor.effectiveView().zoom, -1))}>
        −
      </button>}
      <details ref={menu} className="view-menu" onToggle={event => {
        const details = event.currentTarget
        if (!details.open) { closePixel.current(); return }
        // The toggle task is queued. Only move into the zoom field when focus
        // has not already entered the menu, so keyboard entry is not pulled back.
        const summary = details.querySelector(':scope > summary')
        const active = document.activeElement
        if (!sketch && (active === summary || active === document.body || active === null))
          details.querySelector<HTMLInputElement>('input[role="spinbutton"]')?.focus()
      }}>
        <summary aria-label={text.zoomView} data-testid="zoom-readout">{zoomPercentage}%</summary>
        <div className="view-menu-body">
          {sketch && zoomSteps}
          <PendingEditContext.Provider value={null}><NumberField
            label={text.zoomRatio}
            // Preserve the existing numeric semantics independently of the translated label.
            unit="number"
            value={liveZoom * 100}
            min={MIN_CANVAS_ZOOM * 100}
            max={MAX_CANVAS_ZOOM * 100}
            onChange={(v) => zoom(v / 100)}
          /></PendingEditContext.Provider>
          {!sketch && zoomSteps}
          {!sketch && fitButtons}
          <div className={sketch ? "zoom-presets" : "zoom-presets figma-zoom-presets"}>
            {(sketch ? [25, 50, 100, 200, 400, 800] : [50, 100, 200]).map((p) => (
              <button type="button" key={p} aria-pressed={Math.abs(liveZoom * 100 - p) < .05}
                onClick={() => { zoom(p / 100); closeMenu() }}>
                {sketch ? `${p}%` : label(`缩放到 ${p}%`, `Zoom to ${p}%`)}
              </button>
            ))}
          </div>
          {sketch && fitButtons}
          {sketch && <button type="button" disabled={!s.selection.length} onClick={() => {
            void dispatchEditorCommand(editor, 'center-selection')
            if (menu.current) menu.current.open = false
          }}>{label('中心选择', 'Center selection')}{centerKey && `　${centerKey}`}</button>}
          {sketch && <>
            <label><input type="checkbox" checked={s.grid}
              onChange={e => editor.set({ grid: e.target.checked })} />{label('显示网格', 'Show grid')}</label>
            <button type="button" onClick={() => {
              if (menu.current) menu.current.open = false
              document.querySelector<HTMLButtonElement>('.app-settings-button')?.click()
            }}>{label('网格设置…', 'Grid settings…')}</button>
            <label><input type="checkbox" checked={s.showAuthoredLayout !== false}
              onChange={e => editor.set({ showAuthoredLayout: e.target.checked })} />{label('显示布局', 'Show layout guides')}{profile === 'sketch-like' && shortcut.platform === 'mac' ? '　⌃ L' : ''}</label>
            <label><input type="checkbox" checked={!!s.showOverview}
              onChange={e => editor.set({ showOverview: e.target.checked })} />{label('显示迷你地图', 'Show minimap')}{profile === 'sketch-like' && shortcut.platform === 'mac' ? '　⌃ M' : ''}</label>
            <button type="button" disabled={!s.selection.length || s.doc.nodes[s.selection[0]]?.kind !== 'frame'}
              onClick={() => {
                if (menu.current) menu.current.open = false
                document.getElementById('design-properties-tab')?.click()
                requestAnimationFrame(() => {
                  const heading = document.getElementById('layout-grid-settings')
                  heading?.scrollIntoView({ block: 'nearest' })
                  heading?.focus({ preventScroll: true })
                })
              }}>{label('布局设置…', 'Layout settings…')}</button>
          </>}
          <label><input type="checkbox" aria-label={text.wheelZoom} checked={s.scrollWheelZoom}
            onChange={e => editor.setScrollWheelZoom(e.target.checked)}/>{text.wheelZoom}</label>
          <small>{text.viewNavigationHelp}</small>
          <PixelPreviewSubmenu label={text.pixelPreview} offLabel={text.vectorPreview} value={s.pixelPreview}
            onChoose={choosePreview} onDismiss={dismissViewMenu} panelRef={pixelPanel} closeRef={closePixel} />
          <label><input type="checkbox" aria-label={text.checkerboard} checked={s.checkerboard} onChange={e => editor.set({ checkerboard: e.target.checked })}/>{text.checkerboard}</label>
          <label>
            <input
              type="checkbox"
              checked={s.pixelGrid}
              onChange={(e) => editor.set({ pixelGrid: e.target.checked })}
            />
            {text.pixelGrid} <small>{text.pixelGridThreshold}</small>
          </label>
          <label>
            <input
              type="checkbox"
              checked={s.snapPixels}
              onChange={(e) => editor.set({ snapPixels: e.target.checked })}
            />
            {text.snapPixels}
          </label>
          {!sketch && <label><input type="checkbox" checked={s.showAuthoredLayout !== false}
            onChange={event => editor.set({ showAuthoredLayout: event.target.checked })} />
            {label('布局参考线', 'Layout guides')}
          </label>}
          <label>
            <input
              type="checkbox"
              checked={s.snap}
              onChange={(e) => editor.set({ snap: e.target.checked })}
            />
            {text.snap}
          </label>
          <label><input type="checkbox" checked={!!s.rulers} onChange={e=>editor.set({rulers:e.target.checked})}/>{text.rulers}　⇧R</label>
          {!sketch && outlineAvailable && <details className="view-outline-options">
            <summary>{label('轮廓', 'Outlines')}</summary>
            <label><input type="checkbox" checked={!!s.outlines} disabled={editor.interactionActive}
              onChange={e => editor.set({ outlines: e.target.checked })} />
              {label('显示轮廓', 'Show outlines')} <kbd>{shortcutLabel('toggle-outlines', shortcut)}</kbd>
            </label>
            <label><input type="checkbox" checked={s.outlineHiddenLayers !== false}
              onChange={e => editor.set({ outlineHiddenLayers: e.target.checked })} />
              {label('包含隐藏图层', 'Include hidden layers')}
            </label>
            <label><input type="checkbox" checked={!!s.outlineObjectBounds}
              onChange={e => editor.set({ outlineObjectBounds: e.target.checked })} />
              {label('包含对象边界', 'Include object bounds')}
            </label>
          </details>}
        </div>
      </details>
      {!compact && <><button type="button" title={text.zoomIn} onClick={() => zoom(zoomStep(editor.effectiveView().zoom, 1))}>
        ＋
      </button>
      <i />
      <button type="button" onClick={() => fit()} title={text.fitAll}>
        {text.fit}
      </button></>}
      {!!s.pixelPreview && <span className="pixel-preview-badge">{text.pixel} {s.pixelPreview}×</span>}
    </div>
  )
}
