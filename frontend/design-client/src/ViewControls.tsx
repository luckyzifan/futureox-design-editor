import { dispatchEditorCommand } from './editor-commands'
import { desktopBridge } from './desktop'
import { shortcutLabel, shortcutPlatform } from './shortcut-profiles'
import { useShortcutProfile } from './shortcut-preference'
import { useInterfacePreferences, useInterfaceText } from './interface-preference'
import type { Editor } from './engine'
import { zoomAt, zoomStep, MIN_CANVAS_ZOOM, MAX_CANVAS_ZOOM } from './canvas-camera'
import { NumberField } from './fields'
import { PendingEditContext } from './pending-edit-context'
import { Check, ChevronRight } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
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
  const pixelId = useId()
  const pixelTrigger = useRef<HTMLButtonElement>(null)
  const pixelList = useRef<HTMLDivElement>(null)
  const [pixelOpen, setPixelOpen] = useState(false)
  const closeMenu = (restoreFocus = false) => {
    if (menu.current) menu.current.open = false
    setPixelOpen(false)
    if (restoreFocus) menu.current?.querySelector('summary')?.focus({ preventScroll: true })
  }
  useEffect(() => {
    const dismiss = (event: Event) => {
      if (menu.current && !menu.current.contains(event.target as Node)) closeMenu()
    }
    const blur = () => closeMenu()
    document.addEventListener('pointerdown', dismiss, true); window.addEventListener('blur', blur)
    return () => { document.removeEventListener('pointerdown', dismiss, true); window.removeEventListener('blur', blur) }
  }, [])
  useLayoutEffect(() => {
    const panel = pixelList.current, trigger = pixelTrigger.current
    const body = menu.current?.querySelector('.view-menu-body')
    if (!pixelOpen || !panel || !trigger || !body) return
    panel.showPopover?.()
    const place = () => {
      const anchor = trigger.getBoundingClientRect(), parent = body.getBoundingClientRect()
      const left = parent.left - panel.offsetWidth - 4
      panel.style.left = `${Math.max(8, Math.min(window.innerWidth - panel.offsetWidth - 8, left >= 8 ? left : parent.right + 4))}px`
      panel.style.top = `${Math.max(8, Math.min(window.innerHeight - panel.offsetHeight - 8, anchor.top))}px`
    }
    place()
    panel.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus({ preventScroll: true })
    window.addEventListener('resize', place)
    body.addEventListener('scroll', place)
    return () => { window.removeEventListener('resize', place); body.removeEventListener('scroll', place) }
  }, [pixelOpen])
  const zoom = (value: number) => {
    // Parked wheel cameras must land before button math: otherwise the next
    // rAF commit rolls the button's zoom back to the pre-click camera.
    const view = editor.flushPendingView()
    editor.set({ view: zoomAt(view, value, { x: size.width / 2, y: size.height / 2 }) })
  }
  const preview = (value: 0 | 1 | 2) =>
    editor.set({ pixelPreview: value, ...(value ? { lastPixelPreview: value } : {}) })
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
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape' && menu.current?.open) { closeMenu(true); e.preventDefault() } }}
    >
      {!compact && <button type="button" title={text.zoomOut} onClick={() => zoom(zoomStep(editor.effectiveView().zoom, -1))}>
        −
      </button>}
      <details ref={menu} className="view-menu" onToggle={event => {
        if (event.target !== event.currentTarget) return
        if (!event.currentTarget.open) setPixelOpen(false)
        else if (!sketch) event.currentTarget.querySelector<HTMLInputElement>('input[role="spinbutton"]')?.focus()
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
          {sketch ? <label>
            {text.pixelPreview}
            <select
              aria-label={text.pixelPreview}
              value={s.pixelPreview}
              onChange={(e) => preview(Number(e.target.value) as 0 | 1 | 2)}
            >
              <option value={0}>{text.vectorPreview}</option>
              <option value={1}>1×</option>
              <option value={2}>2×</option>
            </select>
          </label> : <div className="pixel-preview-submenu" onBlur={event => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPixelOpen(false)
          }}>
            <button type="button" ref={pixelTrigger} aria-haspopup="menu" aria-expanded={pixelOpen}
              aria-controls={pixelOpen ? pixelId : undefined} onClick={() => setPixelOpen(!pixelOpen)}
              onKeyDown={event => {
                if (event.key !== 'ArrowRight' && event.key !== 'ArrowDown') return
                event.preventDefault()
                setPixelOpen(true)
              }}>{text.pixelPreview}<ChevronRight size={14} aria-hidden="true" /></button>
            {pixelOpen && <div ref={pixelList} id={pixelId} popover="manual" role="menu" aria-label={text.pixelPreview}
              onKeyDown={event => {
                if (event.key === 'Escape' || event.key === 'ArrowLeft') {
                  event.preventDefault(); event.stopPropagation()
                  pixelTrigger.current?.focus({ preventScroll: true })
                  setPixelOpen(false)
                  return
                }
                if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
                event.preventDefault()
                const choices = Array.from(event.currentTarget.querySelectorAll('button'))
                const index = choices.findIndex(choice => choice === event.target)
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 :
                  (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length
                choices[next]?.focus()
              }}>
              {([0, 1, 2] as const).map(value => <button type="button" key={value} role="menuitemradio" tabIndex={-1}
                aria-checked={s.pixelPreview === value} onClick={() => { preview(value); closeMenu(true) }}>
                <span className="pixel-preview-check" aria-hidden="true">{s.pixelPreview === value && <Check size={13} />}</span>
                {value === 0 ? label('关闭', 'Disabled') : `${value}×`}
              </button>)}
            </div>}
          </div>}
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
