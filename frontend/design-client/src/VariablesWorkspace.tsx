import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { Editor } from './engine'
import { commitPendingEdits } from './pending-edits'
import { useProfessionalDialogText } from './professional-dialog-messages'
import { VariablesPanel } from './VariablesPanel'

type ResizeAxis = 'width' | 'height' | 'both'

export function VariablesWorkspace({ editor, floating, onToggleFloating, onClose }: {
  editor: Editor
  floating: boolean
  onToggleFloating: () => void
  onClose: () => void
}) {
  const { locale, tr } = useProfessionalDialogText()
  const host = useRef<HTMLElement>(null)
  const [size, setSize] = useState({ width: 642, height: 380 })
  const drag = useRef<{ pointer: number; x: number; y: number; width: number; height: number } | null>(null)
  const resize = (width: number, height: number) => {
    const bounds = host.current?.getBoundingClientRect()
    if (!bounds) return
    setSize({
      width: Math.max(0, Math.min(Math.max(320, width), innerWidth - bounds.left - 12)),
      height: Math.max(0, Math.min(Math.max(240, height), innerHeight - bounds.top - 12)),
    })
  }
  const begin = (event: PointerEvent<HTMLButtonElement>) => {
    const bounds = host.current?.getBoundingClientRect()
    if (event.button !== 0 || !bounds) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, width: bounds.width, height: bounds.height }
  }
  const move = (event: PointerEvent<HTMLButtonElement>, axis: ResizeAxis) => {
    const start = drag.current
    if (!start || start.pointer !== event.pointerId) return
    resize(start.width + (axis === 'height' ? 0 : event.clientX - start.x),
      start.height + (axis === 'width' ? 0 : event.clientY - start.y))
  }
  const resizeByKey = (event: KeyboardEvent<HTMLButtonElement>, axis: ResizeAxis) => {
    const bounds = host.current?.getBoundingClientRect()
    if (!bounds) return
    const step = event.shiftKey ? 48 : 12
    const x = axis === 'height' ? 0 : event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
    const y = axis === 'width' ? 0 : event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
    if (!x && !y) {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (commitPendingEdits(editor)) onClose()
      }
      return
    }
    event.preventDefault()
    event.stopPropagation()
    resize(bounds.width + x, bounds.height + y)
  }
  const labels = locale === 'en'
    ? { width: 'Resize variables horizontally', height: 'Resize variables vertically', both: 'Resize variables window' }
    : { width: '调整变量浮窗宽度', height: '调整变量浮窗高度', both: '调整变量浮窗大小' }
  return <section ref={host} id="variables-workspace" className="variables-workspace"
    data-floating={floating || undefined} aria-label={tr('本地变量')} style={floating ? size : undefined}>
    <div className="variables-workspace-scroll">
      <VariablesPanel editor={editor} onReturnToCanvas={onClose} floating={floating} toggleFloating={onToggleFloating} />
    </div>
    {floating && (['width', 'height', 'both'] as const).map(axis =>
      <button type="button" key={axis} className="variables-resize" data-variable-resize={axis}
        aria-label={labels[axis]} onPointerDown={begin} onPointerMove={event => move(event, axis)}
        onLostPointerCapture={() => { drag.current = null }} onKeyDown={event => resizeByKey(event, axis)} />)}
  </section>
}
