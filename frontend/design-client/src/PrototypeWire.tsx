import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { Play, Plus } from 'lucide-react'
import type { Editor } from './engine'
import { screenToWorld, worldToScreen, type CanvasCamera, type CanvasSize } from './canvas-camera'
import { apply, inverse, type SceneEntry } from './geometry'
import type { DesignDocument, Point } from './model'
import { commitPendingEdits } from './pending-edits'
import { addPrototypeFlow, outerPrototypeFrame, prototypeFlowsOnPage } from './prototype-flows'

export function PrototypeFlowBadges({ document, page, entries, view, size, locale, onPreview }: {
  document: DesignDocument; page: string; entries: readonly SceneEntry[]; view: CanvasCamera
  size: CanvasSize; locale: string; onPreview: (startNode: string) => void
}) {
  const flows = useMemo(() => prototypeFlowsOnPage(document, page), [document, page])
  if (!flows.length) return null
  return <div className="prototype-wire-layer">
    {flows.map(flow => {
      const entry = entries.find(entry => entry.id === flow.startNode && !entry.hidden)
      if (!entry) return null
      const point = worldToScreen(view, entry.bounds)
      const end = point.x + entry.bounds.width * view.zoom
      if (end < 0 || point.x > size.width || point.y < -32 || point.y > size.height) return null
      const left = Math.max(4, Math.min(point.x, size.width - 145))
      const top = point.y < 36 ? Math.max(4, point.y + 18) : point.y - 35
      const label = locale === 'en' ? `Preview ${flow.name}` : `预览 ${flow.name}`
      return <button key={flow.id} type="button" className="prototype-flow-badge" data-testid="prototype-flow-badge"
        aria-label={label} title={label} style={{ left, top }} onClick={() => onPreview(flow.startNode)}>
        <Play size={11} aria-hidden="true" /><span>{flow.name}</span>
      </button>
    })}
  </div>
}

type WirePress = { pointer: number; origin: Point; session: number; revision: number; moved: boolean }

/** The handle owns pointer input until release. The wire and target outline
 * are transient canvas chrome and never enter the rendering document. */
export function PrototypeWire({ editor, entries, view, locale }: {
  editor: Editor; entries: readonly SceneEntry[]; view: CanvasCamera; locale: string
}) {
  const { doc, page, selection } = editor.state
  const selected = selection.length === 1 ? selection[0] : undefined
  const source = selected ? entries.find(entry => entry.id === selected && !entry.hidden && !entry.locked) : undefined
  const node = source && doc.nodes[source.id]
  const usable = node && node.kind !== 'slice' && !node.instanceOrigin
  const layer = useRef<HTMLDivElement>(null)
  const press = useRef<WirePress | null>(null)
  const ignoreMouseClick = useRef(false)
  const [preview, setPreview] = useState<{ point: Point; target?: SceneEntry } | null>(null)
  const [choosing, setChoosing] = useState(false)
  const targets = useMemo(() => {
    if (!source) return []
    const parents = editor.parentMap(doc)
    return entries.filter(entry => entry.id !== selected && !entry.hidden &&
      doc.nodes[entry.id]?.kind === 'frame' && !doc.nodes[entry.id].instanceOrigin &&
      outerPrototypeFrame(doc, entry.id, parents) === entry.id)
  }, [doc, editor, entries, selected, !!source])
  const clear = () => { press.current = null; setPreview(null) }
  useEffect(() => {
    clear()
    setChoosing(false)
  }, [editor, editor.sessionGeneration, editor.state.version, page, selected])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || (!press.current && !choosing)) return
      event.preventDefault()
      event.stopPropagation()
      ignoreMouseClick.current = !!press.current
      clear()
      setChoosing(false)
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [choosing])
  if (!source || !usable || !targets.length) return null
  const from = worldToScreen(view, { x: source.bounds.x + source.bounds.width, y: source.bounds.y + source.bounds.height / 2 })
  const position = (event: PointerEvent) => {
    const box = layer.current!.getBoundingClientRect()
    return { x: event.clientX - box.left, y: event.clientY - box.top }
  }
  const frontToBack = [...targets].reverse()
  const match = (point: Point) => {
    const world = screenToWorld(view, point)
    return frontToBack.find(entry => {
      if (world.x < entry.bounds.x || world.y < entry.bounds.y ||
          world.x > entry.bounds.x + entry.bounds.width || world.y > entry.bounds.y + entry.bounds.height) return false
      const local = apply(inverse(entry.matrix), world)
      const frame = doc.nodes[entry.id]
      return local.x >= 0 && local.y >= 0 && local.x <= frame.width && local.y <= frame.height
    })
  }
  const link = (target: string, expected?: WirePress) => {
    if (editor.state.doc !== doc || editor.state.page !== page || editor.state.selection[0] !== source.id ||
        editor.interactionActive || editor.state.busy || !targets.some(entry => entry.id === target) ||
        expected && (editor.sessionGeneration !== expected.session || editor.state.version !== expected.revision) ||
        !commitPendingEdits(editor)) return
    if (editor.state.doc !== doc) return
    editor.change('连接原型画框', draft => {
      const prototype = draft.prototype ??= { interactions: {} }
      const existing = prototype.interactions[source.id] ??= []
      if (existing.some(event => event.trigger === 'click' && !event.condition &&
        event.actions.some(action => action.kind === 'navigate' && action.target === target))) return
      const start = outerPrototypeFrame(draft, source.id)
      if (start && !draft.nodes[start].locked && prototypeFlowsOnPage(draft, page).length === 0)
        addPrototypeFlow(draft, page, start)
      existing.push({ trigger: 'click', actions: [{ kind: 'navigate', target, transitionStyle: 'none' }] })
    })
  }
  const to = preview?.target ? worldToScreen(view, {
    x: preview.target.bounds.x, y: preview.target.bounds.y + preview.target.bounds.height / 2,
  }) : preview?.point
  const bend = to ? Math.max(18, Math.abs(from.x - to.x) * 0.45) : 0
  const outline = preview?.target?.bounds
  const en = locale === 'en'
  const label = en ? 'Connect prototype' : '连接原型'
  return <div ref={layer} className="prototype-wire-layer">
    {to && <svg className="prototype-wire-preview" aria-hidden="true">
      <path d={`M${from.x} ${from.y} C${from.x+bend} ${from.y} ${to.x-bend} ${to.y} ${to.x} ${to.y}`} />
      {outline && <rect x={outline.x*view.zoom+view.x} y={outline.y*view.zoom+view.y}
        width={outline.width*view.zoom} height={outline.height*view.zoom} />}
    </svg>}
    <button type="button" data-testid="prototype-wire-handle" className="prototype-wire-handle"
      aria-label={label} title={label} style={{ left: from.x, top: from.y }}
      onPointerDown={event => {
        event.stopPropagation()
        if (event.button !== 0 || editor.interactionActive || editor.state.busy || !commitPendingEdits(editor) || editor.state.doc !== doc) return
        ignoreMouseClick.current = false
        event.currentTarget.setPointerCapture(event.pointerId)
        press.current = { pointer: event.pointerId, origin: position(event), session: editor.sessionGeneration,
          revision: editor.state.version, moved: false }
      }}
      onPointerMove={event => {
        if (press.current?.pointer !== event.pointerId) return
        event.stopPropagation()
        const point = position(event)
        if (!press.current.moved && Math.hypot(point.x-press.current.origin.x, point.y-press.current.origin.y) < 3) return
        press.current.moved = true
        setPreview({ point, target: match(point) })
      }}
      onPointerUp={event => {
        const active = press.current
        if (active?.pointer !== event.pointerId) return
        event.stopPropagation()
        const point = position(event)
        const moved = active.moved || Math.hypot(point.x-active.origin.x, point.y-active.origin.y) >= 3
        ignoreMouseClick.current = moved
        clear()
        const target = moved ? match(point) : undefined
        if (target) link(target.id, active)
      }}
      onPointerCancel={clear} onLostPointerCapture={clear}
      onClick={event => {
        event.stopPropagation()
        if (!ignoreMouseClick.current || event.detail === 0) setChoosing(value => !value)
      }}><Plus size={12} aria-hidden="true" /></button>
    {choosing && <select autoFocus className="prototype-wire-choice" style={{ left: from.x+14, top: from.y }}
      aria-label={en ? 'Prototype destination' : '原型目标'} value="" onChange={event => {
        link(event.currentTarget.value)
        setChoosing(false)
      }}>
      <option value="" disabled>{en ? 'Choose a frame' : '选择画框'}</option>
      {targets.map(entry => <option key={entry.id} value={entry.id}>{doc.nodes[entry.id].name}</option>)}
    </select>}
  </div>
}
