import { usePropertyText } from './property-interface-messages'
import { useContext, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ColorEditSession, type ColorDraft } from './color-edit-session'
import { PendingEditContext } from './pending-edit-context'
import { hasCanvasColorPicker, requestCanvasColor } from './canvas-color-picker'
import type { SolidFillTarget } from './property-preview'

/** Transactional solid-fill entry point; ordinary controls must opt in with a
 * semantic target. A callback alone is never enough to claim document ownership. */
export function SolidFillColorInput({ target, value, label, opacity = false }: {
  target: SolidFillTarget; value: string; label: string; opacity?: boolean
}) {
  const { locale, tr } = usePropertyText()
  const editor = useContext(PendingEditContext), trigger = useRef<HTMLButtonElement>(null)
  const [session, setSession] = useState<ColorEditSession | null>(null), [error, setError] = useState('')
  useEffect(() => () => { session?.dispose() }, [session])
  const open = () => {
    if (!editor) { setError('颜色编辑需要有效文档'); return }
    if (session?.active) return
    const next = ColorEditSession.open(editor, target)
    if (!next) { setError('请先结束当前操作；引用填充需先转为本地填充'); return }
    setError(''); setSession(next)
  }
  return <span className="color-input" data-property-preview-trigger>
    <button ref={trigger} type="button" className={opacity ? 'paint-opacity-trigger' : 'color-swatch-trigger'}
      aria-label={label} aria-haspopup="dialog" aria-expanded={!!session?.active}
      style={opacity ? undefined : { background: value }} onClick={open}>
      {opacity ? `${value}%` : <span className="sr-only">{label}</span>}
    </button>
    {error && <span role="alert">{tr(error)}</span>}
    {session && <ColorPickerPopover session={session} trigger={trigger} focusOpacity={opacity} onClose={() => setSession(null)} />}
  </span>
}

export function ColorPickerPopover({ session, trigger, focusOpacity = false, onClose }: {
  session: ColorEditSession; trigger: RefObject<HTMLButtonElement | null>; focusOpacity?: boolean; onClose: () => void
}) {
  const { locale, tr } = usePropertyText()
  const panel = useRef<HTMLDivElement>(null), color = useRef<HTMLInputElement>(null), opacity = useRef<HTMLInputElement>(null)
  const [, render] = useState(0), [model, setModel] = useState<'native' | 'hex'>('native')
  const [position, setPosition] = useState({ left: 8, top: 8 })
  const composing = useRef(false), closed = useRef(false), drag = useRef<{ pointerId: number; draft: ColorDraft } | null>(null)
  const close = useRef(onClose); close.current = onClose
  useEffect(() => session.subscribe(() => {
    if (session.active) render(value => value + 1)
    else if (!closed.current) { closed.current = true; close.current() }
  }), [session])
  useLayoutEffect(() => {
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect(), box = panel.current?.getBoundingClientRect()
      const width = Math.min(316, Math.max(0, window.innerWidth - 16)), height = box?.height || 430
      setPosition({ left: Math.max(8, Math.min((rect?.left ?? 8) - width, window.innerWidth - width - 8)),
        top: Math.max(8, Math.min(rect?.top ?? 8, window.innerHeight - height - 8)) })
    }
    place()
    window.addEventListener('resize', place)
    return () => { window.removeEventListener('resize', place) }
  }, [trigger, locale])
  // Relabel/reclamp without rerunning autofocus or closing the active session.
  useLayoutEffect(() => {
    (focusOpacity ? opacity : color).current?.focus({ preventScroll: true })
    return () => { if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true }) }
  }, [trigger, focusOpacity])
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (!session.active || panel.current?.contains(target) || trigger.current?.contains(target) || target?.closest('[data-property-preview-undo]')) return
      if (hasCanvasColorPicker(session.editor) && target?.closest('[data-testid="canvas"]')) return
      if (!session.commit()) {
        event.preventDefault(); event.stopImmediatePropagation()
        ;(session.valid ? color : opacity).current?.focus({ preventScroll: true })
      }
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [session, trigger])
  const draft = session.draft, simple = /^#[\da-f]{6}$/i.test(draft.color)
  const rgb = simple ? [1, 3, 5].map(at => parseInt(draft.color.slice(at, at + 2), 16)) : null
  const update = (next: Partial<ColorDraft>) => { session.update(next); render(value => value + 1) }
  const cancelDrag = () => {
    const previous = drag.current; drag.current = null
    if (previous && session.active) update(previous.draft)
  }
  const rangeEvents = {
    onPointerDown: (event: React.PointerEvent<HTMLInputElement>) => {
      drag.current = { pointerId: event.pointerId, draft: { ...session.draft } }
      event.currentTarget.setPointerCapture?.(event.pointerId)
    },
    onPointerUp: (event: React.PointerEvent<HTMLInputElement>) => {
      if (drag.current?.pointerId !== event.pointerId) return
      drag.current = null
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    },
    onPointerCancel: cancelDrag,
    onLostPointerCapture: cancelDrag,
  }
  return createPortal(<div ref={panel} role="dialog" aria-label={tr("填充颜色和不透明度")} aria-modal="false"
    className="property-color-popover" data-property-preview style={position}
    onKeyDown={event => {
      if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
      if (event.key === 'Escape' || ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'z' && !event.shiftKey)) {
        event.preventDefault(); event.stopPropagation(); session.cancel(); return
      }
      if (event.key === 'Enter' && !(event.target as Element).closest('button,select')) {
        event.preventDefault(); event.stopPropagation(); session.commit(); return
      }
      if (event.key === 'Tab') {
        const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)') ?? [])]
        const first = controls[0], last = controls.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }}>
    <div className="property-color-heading"><strong>{tr("填充颜色")}</strong><button type="button" aria-label={tr("取消颜色编辑")} onClick={() => session.cancel()}>×</button></div>
    <div className="property-color-sample" aria-hidden="true" style={{ background: session.valid ? draft.color : session.original.color, opacity: session.valid ? Number(draft.opacity) / 100 : 1 }} />
    <label>{tr("显示方式")}<select aria-label={tr("颜色显示方式")} value={model} onChange={event => setModel(event.target.value as 'native' | 'hex')}>
      <option value="native">{tr("原始颜色 / CSS")}</option><option value="hex">{tr("HEX 预览")}</option>
    </select></label>
    {model === 'hex' && <p className="muted">{simple ? draft.color.toUpperCase() : tr('宽色域 / HDR 保留原始值，不转换为 8 位 HEX。')}</p>}
    <label>{tr("颜色值")}<input ref={color} aria-label={tr("填充颜色值")} value={draft.color} spellCheck={false}
      aria-invalid={!session.valid} onChange={event => update({ color: event.target.value })}
      onCompositionStart={() => { composing.current = true; session.setComposing(true) }}
      onCompositionEnd={() => { composing.current = false; session.setComposing(false) }} /></label>
    {rgb && <div className="property-color-components">{['R', 'G', 'B'].map((label, index) => <label key={label}>{label}
      <input type="range" aria-label={`${tr("填充")} ${label}`} min={0} max={255} step={1} value={rgb[index]} {...rangeEvents}
        onChange={event => { const current = session.draft.color; if (!/^#[\da-f]{6}$/i.test(current)) return; const values = [1, 3, 5].map(at => parseInt(current.slice(at, at + 2), 16)); values[index] = Number(event.target.value); update({ color: '#' + values.map(value => value.toString(16).padStart(2, '0')).join('') }) }} />
    </label>)}</div>}
    <label>{tr("填充不透明度 %")}<input ref={opacity} aria-label={tr("填充不透明度 %")} inputMode="decimal" value={draft.opacity}
      aria-invalid={!session.valid} onChange={event => update({ opacity: event.target.value })}
      onCompositionStart={() => { composing.current = true; session.setComposing(true) }}
      onCompositionEnd={() => { composing.current = false; session.setComposing(false) }} /></label>
    <input type="range" aria-label={tr("填充不透明度滑块")} min={0} max={100} step={0.1}
      value={/^\d*(?:\.\d*)?$/.test(draft.opacity) && Number(draft.opacity) <= 100 ? Number(draft.opacity) : 100}
      {...rangeEvents} onChange={event => update({ opacity: event.target.value })} />
    <p className="muted">{tr("仅修改填充；图层不透明度与颜色自身 Alpha 保持独立。")}</p>
    {session.error && <p role="alert">{tr(session.error)}</p>}
    <div className="property-color-actions">
      <button type="button" onClick={() => void session.sample((signal, lease) => requestCanvasColor(session.editor, signal, lease))}>{tr("从画布取色")}</button>
      <button type="button" onClick={() => session.cancel()}>{tr("取消")}</button>
      <button type="button" onClick={() => session.commit()}>{tr("应用")}</button>
    </div>
  </div>, document.body)
}
