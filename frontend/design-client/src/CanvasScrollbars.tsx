import { utilityAction, CanvasAction, ActionReason, ActionSource, type UtilityAction } from './canvas-utility-action'
import { useMemo, useRef } from 'react'
import type { Editor } from './engine'
import type { SceneEntry } from './geometry'
import { unionBounds } from './geometry'
import type { CanvasCamera, CanvasSize } from './canvas-camera'
import { canvasScrollAxis, scrollbarCamera } from './canvas-scrollbars'

export function CanvasScrollbars({ editor, entries, view, size }: { editor: Editor; entries: readonly SceneEntry[]; view: CanvasCamera; size: CanvasSize }) {
  const bounds = useMemo(() => unionBounds(entries.filter(e => e.depth === 0).map(e => e.bounds)), [entries])
  const drag = useRef<{ action: UtilityAction; pointer: number; key: 'x' | 'y'; start: number; axis: ReturnType<typeof canvasScrollAxis>; view: CanvasCamera; session: number; page: string } | null>(null)
  const axes = {
    x: canvasScrollAxis(bounds.x, bounds.width, view.x, view.zoom, size.width),
    y: canvasScrollAxis(bounds.y, bounds.height, view.y, view.zoom, size.height),
  }
  const move = (event: React.PointerEvent) => {
    const d = drag.current
    if (!d || d.pointer !== event.pointerId || d.session !== editor.sessionGeneration || d.page !== editor.state.page) return
    d.action.sample()
    const delta = (d.key === 'x' ? event.clientX : event.clientY) - d.start
    editor.setViewCoalesced({ ...d.view, [d.key]: scrollbarCamera(d.axis, d.axis.offset + delta, d.view.zoom) })
  }
  return <div className="canvas-scrollbars" onPointerDown={e => e.stopPropagation()} onPointerMove={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}>
    {(['x', 'y'] as const).map(key => {
      const axis = axes[key], horizontal = key === 'x'
      return <div key={key} className={`canvas-scrollbar ${horizontal ? 'horizontal' : 'vertical'}`}
        role="scrollbar" aria-label={horizontal ? '水平画布滚动条' : '垂直画布滚动条'} aria-orientation={horizontal ? 'horizontal' : 'vertical'}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(axis.fraction * 100)} aria-controls="design-canvas-view" tabIndex={0}
        onPointerDown={e => {
          e.stopPropagation()
          const action = utilityAction(editor, CanvasAction.scrollbar)
          if (e.button !== 0 || editor.interactionActive) { action.block(ActionReason.busy); return }
          e.preventDefault(); e.currentTarget.focus({ preventScroll: true }); editor.hoverLayer(null, 'canvas')
          const camera = editor.flushPendingView()
          if (!(e.target as Element).closest('.canvas-scrollbar-thumb')) {
            const r = e.currentTarget.getBoundingClientRect(), at = horizontal ? e.clientX - r.left : e.clientY - r.top
            const direction = at < axis.offset ? 1 : -1
            editor.set({ view: { ...camera, [key]: camera[key] + direction * (horizontal ? size.width : size.height) * .9 } })
            action.finish(editor.state.view[key] !== camera[key], { motionObserved: editor.state.view[key] !== camera[key] })
            return
          }
          drag.current = { action, pointer: e.pointerId, key, start: horizontal ? e.clientX : e.clientY, axis, view: camera, session: editor.sessionGeneration, page: editor.state.page }
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={e => { e.stopPropagation(); move(e) }}
        onPointerUp={e => { e.stopPropagation(); move(e); const d = drag.current; drag.current = null; editor.flushPendingView(); d?.action.finish(editor.state.view[d.key] !== d.view[d.key], { motionObserved: editor.state.view[d.key] !== d.view[d.key] }); if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId) }}
        onPointerCancel={() => { drag.current?.action.cancel(); drag.current = null; editor.flushPendingView() }} onLostPointerCapture={() => { drag.current?.action.cancel(ActionReason.lostCapture); drag.current = null }}
        onKeyDown={e => {
          if (editor.interactionActive) return
          const negative = horizontal ? 'ArrowLeft' : 'ArrowUp', positive = horizontal ? 'ArrowRight' : 'ArrowDown'
          if (![negative, positive, 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) return
          const action = utilityAction(editor, CanvasAction.scrollbar, ActionSource.keyboard)
          e.stopPropagation(); e.preventDefault(); const camera = editor.flushPendingView()
          const step = e.key.startsWith('Page') ? (horizontal ? size.width : size.height) * .9 : 40
          const value = e.key === 'Home' ? scrollbarCamera(axis, 0, camera.zoom) : e.key === 'End' ? scrollbarCamera(axis, axis.travel, camera.zoom)
            : camera[key] + (e.key === negative || e.key === 'PageUp' ? step : -step)
          editor.set({ view: { ...camera, [key]: value } })
          action.finish(value !== camera[key], { motionObserved: value !== camera[key] })
        }}>
        <div className="canvas-scrollbar-thumb" style={horizontal ? { width: axis.thumb, left: axis.offset } : { height: axis.thumb, top: axis.offset }} />
      </div>
    })}
  </div>
}
