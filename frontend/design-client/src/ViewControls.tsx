import { useInterfaceText } from './interface-preference'
import type { Editor } from './engine'
import { CANVAS_ZOOM_MIN, CANVAS_ZOOM_MAX, zoomAt, zoomStep } from './canvas-camera'
import { NumberField } from './fields'
import { useEffect, useRef } from 'react'
export function ViewControls({
  editor,
  size,
  fit,
  compact = false,
}: {
  editor: Editor
  compact?: boolean
  size: { width: number; height: number }
  fit: (selection?: boolean) => void
}) {
  const text = useInterfaceText()
  const s = editor.state
  const menu = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const dismiss = (event: Event) => { if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false }
    const blur = () => { if (menu.current) menu.current.open = false }
    document.addEventListener('pointerdown', dismiss, true); window.addEventListener('blur', blur)
    return () => { document.removeEventListener('pointerdown', dismiss, true); window.removeEventListener('blur', blur) }
  }, [])
  const zoom = (value: number) => {
    // Parked wheel cameras must land before button math: otherwise the next
    // rAF commit rolls the button's zoom back to the pre-click camera.
    const view = editor.flushPendingView()
    editor.set({ view: zoomAt(view, value, { x: size.width / 2, y: size.height / 2 }) })
  }
  const preview = (value: 0 | 1 | 2) =>
    editor.set({ pixelPreview: value, ...(value ? { lastPixelPreview: value } : {}) })
  return (
    <div
      className={`canvas-controls ${compact ? 'compact-controls' : ''}`}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape' && menu.current?.open) { menu.current.open = false; menu.current.querySelector('summary')?.focus(); e.preventDefault() } }}
    >
      {!compact && <button type="button" title={text.zoomOut} onClick={() => zoom(zoomStep(editor.effectiveView().zoom, -1))}>
        −
      </button>}
      <details ref={menu} className="view-menu">
        <summary aria-label={text.zoomView}>{Number((s.view.zoom * 100).toFixed(1))}%</summary>
        <div className="view-menu-body">
          {compact && <div className="zoom-steps"><button type="button" title={text.zoomOut} onClick={() => zoom(zoomStep(editor.effectiveView().zoom, -1))}>−</button><button type="button" title={text.zoomIn} onClick={() => zoom(zoomStep(editor.effectiveView().zoom, 1))}>＋</button></div>}
          <NumberField
            label={text.zoomRatio}
            // Preserve the existing numeric semantics independently of the translated label.
            unit="number"
            value={s.view.zoom * 100}
            min={CANVAS_ZOOM_MIN * 100}
            max={CANVAS_ZOOM_MAX * 100}
            onChange={(v) => zoom(v / 100)}
          />
          <div className="zoom-presets">
            {[25, 50, 100, 200, 400, 800].map((p) => (
              <button type="button" key={p} onClick={() => { zoom(p / 100); if (menu.current) menu.current.open = false }}>
                {p}%
              </button>
            ))}
          </div>
          <button type="button" onClick={() => { fit(); if (menu.current) menu.current.open = false }}>
            {text.fitAll}　⇧1
          </button>
          <button type="button" onClick={() => { fit(true); if (menu.current) menu.current.open = false }}>
            {text.fitSelection}　⇧2
          </button>
          <label><input type="checkbox" aria-label={text.wheelZoom} checked={s.scrollWheelZoom}
            onChange={e => editor.setScrollWheelZoom(e.target.checked)}/>{text.wheelZoom}</label>
          <small>{text.viewNavigationHelp}</small>
          <label>
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
          </label>
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
          <label>
            <input
              type="checkbox"
              checked={s.snap}
              onChange={(e) => editor.set({ snap: e.target.checked })}
            />
            {text.snap}
          </label>
          <label><input type="checkbox" checked={!!s.rulers} onChange={e=>editor.set({rulers:e.target.checked})}/>{text.rulers}　⇧R</label>
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
