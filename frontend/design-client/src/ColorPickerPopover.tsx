import { usePropertyText } from './property-interface-messages'
import { useContext, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ColorEditSession, type ColorDraft } from './color-edit-session'
import { PendingEditContext } from './pending-edit-context'
import { hasCanvasColorPicker, requestCanvasColor } from './canvas-color-picker'
import type { SolidFillTarget } from './property-preview'
import type { Paint } from './model'
import { validColor } from './color'
import { applyNotationChannel, collectFileColors, formatHex, hsbToRgb, notationChannels, parseHex, rgbToHsb, type ColorNotation } from './color-field'
import { eyedropperChord, rememberPaintChannel, type PaintChannel } from './eyedropper-target'

type KindChoice = Paint['kind'] | 'none'
type KindPatch = { color: string; opacity: number }

/** Transactional solid-fill entry point; ordinary controls must opt in with a
 * semantic target. A callback alone is never enough to claim document ownership. */
export function SolidFillColorInput({ target, value, label, opacity = false, kind, onKind, channel = 'fill', buttonText }: {
  target: SolidFillTarget; value: string; label: string; opacity?: boolean
  kind?: Paint['kind']; onKind?: (kind: KindChoice, patch?: KindPatch) => void; channel?: PaintChannel
  buttonText?: string
}) {
  const { tr } = usePropertyText()
  const editor = useContext(PendingEditContext), trigger = useRef<HTMLButtonElement>(null)
  const [session, setSession] = useState<ColorEditSession | null>(null), [error, setError] = useState('')
  useEffect(() => () => { session?.dispose() }, [session])
  const open = () => {
    rememberPaintChannel(editor, channel)
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
      {buttonText ?? (opacity ? `${value} %` : <span className="sr-only">{label}</span>)}
    </button>
    {error && <span role="alert">{tr(error)}</span>}
    {session && <ColorPickerPopover session={session} trigger={trigger} focusOpacity={opacity} kind={kind} onKind={onKind} onClose={() => setSession(null)} />}
  </span>
}

/** Stroke and other paints have no preview lease. The same popover commits once. */
export function LoosePaintColor({ label, color, opacity, hex, kind, onChange, onKind, channel = 'stroke' }: {
  label: string; color: string; opacity: number; hex: string; kind?: Paint['kind']
  onChange: (patch: { color: string; opacity: number }) => void
  onKind?: (kind: KindChoice, patch?: KindPatch) => void; channel?: PaintChannel
}) {
  const { tr } = usePropertyText()
  const editor = useContext(PendingEditContext)
  const swatch = useRef<HTMLButtonElement>(null), alpha = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState<null | { focusOpacity: boolean }>(null)
  const [draft, setDraft] = useState<ColorDraft>({ color, opacity: String(opacity * 100) })
  const [error, setError] = useState('')
  const opacityNow = useRef(draft.opacity)
  opacityNow.current = draft.opacity
  const show = (focusOpacity: boolean) => {
    rememberPaintChannel(editor, channel)
    setDraft({ color, opacity: String(opacity * 100) })
    setError(''); setOpen({ focusOpacity })
  }
  const managed = !!editor?.state.doc.colorManagement
  const opacityOk = (value: string) => /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()) && Number(value) >= 0 && Number(value) <= 100
  const valid = validColor(draft.color, managed) && opacityOk(draft.opacity)
  return <>
    <button ref={swatch} type="button" className="color-swatch-trigger" aria-label={label} aria-haspopup="dialog" aria-expanded={!!open && !open.focusOpacity}
      style={{ background: color }} onClick={() => show(false)}><span className="sr-only">{label}</span></button>
    <span className="paint-hex">{hex}</span>
    <button ref={alpha} type="button" className="paint-opacity-trigger" aria-label={tr('填充不透明度')} aria-haspopup="dialog" aria-expanded={!!open?.focusOpacity}
      onClick={() => show(true)}>{Math.round(opacity * 100)} %</button>
    {open && <MacColorDialog trigger={open.focusOpacity ? alpha : swatch} focusOpacity={open.focusOpacity} preview={false}
      color={draft.color} opacity={draft.opacity} valid={valid} error={error} kind={kind}
      onUpdate={patch => { setError(''); setDraft(value => ({ ...value, ...patch })) }}
      onComposition={() => {}}
      onCommit={() => {
        if (!valid) { setError('请输入有效颜色和 0–100 的填充不透明度'); return false }
        onChange({ color: draft.color, opacity: Number(draft.opacity) / 100 }); setOpen(null); return true
      }}
      onCancel={() => setOpen(null)}
      onSample={() => {
        if (!editor) return
        void requestCanvasColor(editor).then(result => {
          setDraft(value => ({ ...value, color: result.sRGBHex }))
          onChange({ color: result.sRGBHex, opacity: Number(opacityNow.current) / 100 })
        }).catch(reason => { if ((reason as Error).name !== 'AbortError') setError('画布取色失败，请重试') })
      }}
      onKind={kindName => { setOpen(null); onKind?.(kindName, { color: draft.color, opacity: Number(draft.opacity) / 100 }) }}
    />}
  </>
}

export function ColorPickerPopover({ session, trigger, focusOpacity = false, onClose, kind, onKind }: {
  session: ColorEditSession; trigger: RefObject<HTMLButtonElement | null>; focusOpacity?: boolean; onClose: () => void
  kind?: Paint['kind']; onKind?: (kind: KindChoice, patch?: KindPatch) => void
}) {
  const [, render] = useState(0)
  const closed = useRef(false), close = useRef(onClose)
  close.current = onClose
  useEffect(() => session.subscribe(() => {
    if (session.active) render(value => value + 1)
    else if (!closed.current) { closed.current = true; close.current() }
  }), [session])
  const draft = session.draft
  return <MacColorDialog trigger={trigger} focusOpacity={focusOpacity} preview
    color={draft.color} opacity={draft.opacity} valid={session.valid} error={session.error} kind={kind}
    onUpdate={patch => { session.update(patch); render(value => value + 1) }}
    onComposition={composing => session.setComposing(composing)}
    onCommit={() => session.commit()}
    onCancel={() => session.cancel()}
    onSample={() => void session.sample((signal, lease) => requestCanvasColor(session.editor, signal, lease))}
    onKind={onKind ? kindName => { if (!session.commit()) return; onKind(kindName) } : undefined}
  />
}

function MacColorDialog({ trigger, focusOpacity, preview, color: colorValue, opacity: opacityValue, valid, error, kind, onUpdate, onComposition, onCommit, onCancel, onSample, onKind }: {
  trigger: RefObject<HTMLButtonElement | null>; focusOpacity: boolean; preview: boolean
  color: string; opacity: string; valid: boolean; error: string; kind?: Paint['kind']
  onUpdate: (patch: Partial<ColorDraft>) => void
  onComposition: (composing: boolean) => void
  onCommit: () => boolean
  onCancel: () => void
  onSample: () => void
  onKind?: (kind: KindChoice, patch?: KindPatch) => void
}) {
  const { tr } = usePropertyText()
  const editor = useContext(PendingEditContext)
  const panel = useRef<HTMLDivElement>(null), color = useRef<HTMLInputElement>(null), opacity = useRef<HTMLInputElement>(null)
  const [notation, setNotation] = useState<ColorNotation>('HEX')
  const [tab, setTab] = useState<'custom' | 'libraries'>('custom')
  const [menu, setMenu] = useState(false), [cssMenu, setCssMenu] = useState(false)
  const [displayMode, setDisplayMode] = useState<'native' | 'hex'>('native')
  const [heldHue, setHeldHue] = useState(() => { const rgb = parseHex(colorValue); return rgb ? rgbToHsb(rgb[0], rgb[1], rgb[2]).h : 0 })
  const [position, setPosition] = useState({ left: 8, top: 8 })
  const composing = useRef(false), drag = useRef<{ pointerId: number; color: string; opacity: string } | null>(null)
  const draft = { color: colorValue, opacity: opacityValue }
  const simple = /^#[\da-f]{6}$/i.test(draft.color)
  const rgb = simple ? parseHex(draft.color) : null
  const hsb = rgb ? rgbToHsb(rgb[0], rgb[1], rgb[2]) : null
  const hue = hsb && hsb.s > 0.001 ? hsb.h : heldHue
  useEffect(() => { if (hsb && hsb.s > 0.001) setHeldHue(hsb.h) }, [draft.color])
  useLayoutEffect(() => {
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect(), box = panel.current?.getBoundingClientRect()
      const width = Math.min(252, Math.max(0, window.innerWidth - 16)), height = box?.height || 520
      setPosition({ left: Math.max(8, Math.min((rect?.left ?? 8) - width - 8, window.innerWidth - width - 8)),
        top: Math.max(8, Math.min(rect?.top ?? 8, window.innerHeight - height - 8)) })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [trigger, tab, notation])
  useLayoutEffect(() => {
    (focusOpacity ? opacity : color).current?.focus({ preventScroll: true })
    return () => { if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true }) }
  }, [trigger, focusOpacity])
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (panel.current?.contains(target) || trigger.current?.contains(target) || target?.closest('[data-property-preview-undo]')) return
      if (preview && editor && hasCanvasColorPicker(editor) && target?.closest('[data-testid="canvas"]')) return
      if (!onCommit()) {
        event.preventDefault(); event.stopImmediatePropagation()
        ;(valid ? color : opacity).current?.focus({ preventScroll: true })
      }
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [editor, preview, valid, onCommit])
  const update = (next: Partial<ColorDraft>) => onUpdate(next)
  const cancelDrag = () => {
    const previous = drag.current; drag.current = null
    if (previous) update({ color: previous.color, opacity: previous.opacity })
  }
  const rangeEvents = {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      drag.current = { pointerId: event.pointerId, color: draft.color, opacity: draft.opacity }
      event.currentTarget.setPointerCapture?.(event.pointerId)
    },
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => {
      if (drag.current?.pointerId !== event.pointerId) return
      drag.current = null
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    },
    onPointerCancel: cancelDrag,
    onLostPointerCapture: cancelDrag,
  }
  const pickArea = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (!rect.width || !rect.height || !hsb) return
    const saturation = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
    const brightness = Math.max(0, Math.min(1, 1 - (event.clientY - rect.top) / rect.height))
    update({ color: formatHex(hsbToRgb(hue, saturation, brightness)) })
  }
  const fileColors = editor ? collectFileColors(editor.state.doc, editor.state.page) : { styles: [], colors: [] }
  const channels = simple && notation !== 'HEX' ? notationChannels(draft.color, notation) : null
  const platform = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? 'mac' : 'other'
  return createPortal(<div ref={panel} role="dialog" aria-label={tr('填充颜色和不透明度')} aria-modal="false"
    className="property-color-popover" data-property-preview={preview ? '' : undefined} style={position}
    onKeyDown={event => {
      if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
      if (eyedropperChord(event, platform)) { event.preventDefault(); event.stopPropagation(); onSample(); return }
      if (event.key === 'Escape' || ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'z' && !event.shiftKey)) {
        if (event.key === 'Escape' && (menu || cssMenu)) { event.preventDefault(); event.stopPropagation(); setMenu(false); setCssMenu(false); return }
        event.preventDefault(); event.stopPropagation(); onCancel(); return
      }
      if (event.key === 'Enter' && !(event.target as Element).closest('button,select')) {
        event.preventDefault(); event.stopPropagation(); onCommit(); return
      }
      if (event.key === 'Tab') {
        const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)') ?? [])]
        const first = controls[0], last = controls.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }}>
    <button type="button" className="property-color-close" aria-label={tr('取消颜色编辑')} onClick={() => onCancel()}>×</button>
    <div className="property-color-tabs" role="tablist" aria-label={tr('颜色来源')}>
      <button type="button" role="tab" aria-selected={tab === 'custom'} onClick={() => setTab('custom')}>{tr('自定义')}</button>
      <button type="button" role="tab" aria-selected={tab === 'libraries'} onClick={() => setTab('libraries')}>{tr('资料库')}</button>
    </div>
    <button type="button" className="property-color-add" disabled title={tr('颜色样式从本文件读取')}>+</button>
    {tab === 'libraries' ? <div className="property-color-libraries">
      <p>{tr('颜色样式')}</p>
      {fileColors.styles.length ? <div className="property-color-swatches">{fileColors.styles.map(style => <button type="button" key={style.name} onClick={() => update({ color: style.color })} title={style.name} style={{ background: style.color }}><span className="sr-only">{style.name}</span></button>)}</div> : <p className="muted">{tr('此文件还没有颜色样式')}</p>}
      <p>{tr('本文件颜色')}</p>
      {fileColors.colors.length ? <div className="property-color-swatches">{fileColors.colors.map(swatch => <button type="button" key={swatch} aria-label={swatch} onClick={() => update({ color: swatch.toLowerCase() })} style={{ background: swatch }} />)}</div> : <p className="muted">{tr('此页还没有纯色')}</p>}
    </div> : <>
      <div className="property-color-kinds" role="toolbar" aria-label={tr('填充类型')}>
        {(['solid', 'linear', 'radial', 'angular', 'diamond', 'image'] as const).map(id => <button type="button" key={id} aria-label={tr(kindLabel[id])} aria-pressed={kind === id} onClick={() => onKind?.(id)}>{typeIcon(id)}</button>)}
        <button type="button" aria-label={tr('视频')} disabled title={tr('视频填充尚未提供')}>{typeIcon('video')}</button>
        <button type="button" aria-label={tr('变量')} disabled title={tr('变量填色尚未提供')}>{typeIcon('variables')}</button>
        <button type="button" aria-label={tr('去掉填充')} aria-pressed={false} onClick={() => onKind?.('none')}>{typeIcon('none')}</button>
      </div>
      {simple && <div className="property-color-area" data-color-area role="application" aria-label={tr('饱和度与亮度')}
        style={{ backgroundColor: `hsl(${hue} 100% 50%)`, backgroundImage: 'linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,transparent)' }}
        onPointerDown={event => { rangeEvents.onPointerDown(event); pickArea(event) }}
        onPointerMove={event => { if (drag.current) pickArea(event) }}
        {...{ onPointerUp: rangeEvents.onPointerUp, onPointerCancel: rangeEvents.onPointerCancel, onLostPointerCapture: rangeEvents.onLostPointerCapture }}>
        {hsb && <i style={{ left: `${hsb.s * 100}%`, top: `${(1 - hsb.b) * 100}%`, background: draft.color }} />}
      </div>}
      <div className="property-color-sliders">
        <button type="button" className="property-color-dropper" aria-label={tr('从画布取色')} onClick={() => onSample()}>{dropperIcon()}</button>
        <div>
          {simple && <input type="range" className="property-color-hue" aria-label={tr('色相滑块')} min={0} max={360} step={1} value={Math.round(hue)}
            {...rangeEvents} onChange={event => { const next = Number(event.target.value); setHeldHue(next); if (hsb && hsb.s > 0.001) update({ color: formatHex(hsbToRgb(next, hsb.s, hsb.b)) }) }} />}
          <input type="range" className="property-color-opacity" aria-label={tr('填充不透明度滑块')} min={0} max={100} step={0.1}
            style={{ ['--picker-swatch' as string]: simple ? draft.color : '#000000' }}
            value={/^\d*(?:\.\d*)?$/.test(draft.opacity) && Number(draft.opacity) <= 100 ? Number(draft.opacity) : 100}
            {...rangeEvents} onChange={event => update({ opacity: event.target.value })} />
        </div>
      </div>
      <div className="property-color-mode">
        <button type="button" aria-label={tr('颜色模型')} aria-haspopup="listbox" aria-expanded={menu} onClick={() => { setMenu(value => !value); setCssMenu(false) }}>{notationLabel[notation]}</button>
        {menu && <div className="property-color-menu" role="listbox">
          {(['HEX', 'RGB'] as const).map(id => <button type="button" key={id} role="option" aria-selected={notation === id} onClick={() => { setNotation(id); setMenu(false) }}>{notationLabel[id]}</button>)}
          <button type="button" aria-expanded={cssMenu} onClick={() => setCssMenu(value => !value)}>CSS</button>
          {cssMenu && (['HSL', 'HSB'] as const).map(id => <button type="button" key={id} role="option" aria-selected={notation === id} onClick={() => { setNotation(id); setMenu(false); setCssMenu(false) }}>{notationLabel[id]}</button>)}
        </div>}
        {notation === 'HEX' || !simple ? <label className="property-color-hex">{tr('颜色值')}<input ref={color} aria-label={tr('填充颜色值')} value={draft.color} data-hex-mask={simple ? 'true' : undefined} spellCheck={false}
          aria-invalid={!valid} onChange={event => update({ color: event.target.value })}
          onCompositionStart={() => { composing.current = true; onComposition(true) }}
          onCompositionEnd={() => { composing.current = false; onComposition(false) }} /></label>
          : <div className="property-color-channels">{channels!.map((value, index) => {
            const name = (notation === 'RGB' ? ['R', 'G', 'B'] : notation === 'HSB' ? ['H', 'S', 'B'] : ['H', 'S', 'L'])[index]
            return <label key={name}>{name}<input aria-label={notation === 'RGB' ? tr(`填充 ${name}`) : `${notation} ${name}`} inputMode="numeric" value={String(value)}
              onChange={event => { if (event.target.value.trim() === '' || !simple) return; const next = Number(event.target.value); if (!Number.isFinite(next)) return; update({ color: applyNotationChannel(draft.color, notation, index, next) }) }} />
            </label>
          })}</div>}
        {notation !== 'HEX' && simple && <input ref={color} className="property-color-raw" aria-label={tr('填充颜色值')} value={draft.color} spellCheck={false}
          aria-invalid={!valid} onChange={event => update({ color: event.target.value })}
          onCompositionStart={() => { composing.current = true; onComposition(true) }}
          onCompositionEnd={() => { composing.current = false; onComposition(false) }} />}
        <label className="property-color-alpha">{tr('填充不透明度 %')}<input ref={opacity} aria-label={tr('填充不透明度 %')} inputMode="decimal" value={draft.opacity}
          aria-invalid={!valid} onChange={event => update({ opacity: event.target.value })}
          onCompositionStart={() => { composing.current = true; onComposition(true) }}
          onCompositionEnd={() => { composing.current = false; onComposition(false) }} /></label>
        <span aria-hidden="true">%</span>
      </div>
      {!simple && <label>{tr('显示方式')}<select aria-label={tr('颜色显示方式')} value={displayMode} onChange={event => setDisplayMode(event.target.value as 'native' | 'hex')}>
        <option value="native">{tr('原始颜色 / CSS')}</option><option value="hex">{tr('HEX 预览')}</option>
      </select></label>}
      {!simple && displayMode === 'hex' && <p className="muted">{tr('宽色域 / HDR 保留原始值，不转换为 8 位 HEX。')}</p>}
    </>}
    {error && <p role="alert">{tr(error)}</p>}
    <div className="property-color-actions">
      <button type="button" onClick={() => onCancel()}>{tr('取消')}</button>
      <button type="button" onClick={() => onCommit()}>{tr('应用')}</button>
    </div>
  </div>, document.body)
}

const notationLabel: Record<ColorNotation, string> = { HEX: 'Hex', RGB: 'RGB', HSL: 'HSL', HSB: 'HSB' }
const kindLabel = { solid: '纯色', linear: '线性渐变', radial: '径向渐变', angular: '角度渐变', diamond: '菱形渐变', image: '图片' } as const

function typeIcon(id: string) {
  const common = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }
  if (id === 'solid') return <svg {...common}><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" /></svg>
  if (id === 'linear') return <svg {...common}><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" /><path d="M4 12 12 4" /></svg>
  if (id === 'radial') return <svg {...common}><circle cx="8" cy="8" r="5.2" /><circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" /></svg>
  if (id === 'angular') return <svg {...common}><path d="M8 2.8A5.2 5.2 0 1 1 2.8 8" /><path d="M8 8h5.2" /></svg>
  if (id === 'diamond') return <svg {...common}><path d="M8 2.2 13.8 8 8 13.8 2.2 8Z" /></svg>
  if (id === 'image') return <svg {...common}><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="m4 11 2.4-2.4L9 11l1.4-1.4L13 11" /><circle cx="6" cy="6.2" r=".8" fill="currentColor" stroke="none" /></svg>
  if (id === 'video') return <svg {...common}><rect x="2.2" y="4" width="8.2" height="8" rx="1.2" /><path d="M10.4 6.5 13.8 5v6l-3.4-1.5Z" /></svg>
  if (id === 'variables') return <svg {...common}><circle cx="8" cy="8" r="5.2" /><path d="M8 2.8v10.4" /></svg>
  return <svg {...common}><circle cx="8" cy="8" r="5.2" /><path d="m4.4 11.6 7.2-7.2" /></svg>
}

function dropperIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="m9.2 2.6 4.2 4.2M8.2 3.6 3.4 8.4a2 2 0 0 0 0 2.8l.4.4-2.2 2.2M6.6 8.8 10.8 4.6" /></svg>
}
