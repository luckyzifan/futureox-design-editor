import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowLeftRight, Move, RotateCw, Waves, X } from 'lucide-react'
import { changeBlurStopRadius, insertBlurStop, isMotionZoomBlur, setMotionZoomMode, setProgressiveMode, setProgressiveRadius, setSketchBlurMode } from './blur-settings'
import { NumberField } from './fields'
import type { LiveBlur } from './live-blur'
import { defaultColorControls, MAX_BLUR_STOPS, type DesignNode, type Effect } from './model'
import { usePropertyText } from './property-interface-messages'
import { UnitNumberField } from './UnitNumberField'

type Props = {
  effect: Effect
  layer: Pick<DesignNode, 'width' | 'height'>
  label: string
  sketchModes?: boolean
  blurStopIndex?: number
  onSelectBlurStop?: (index: number) => void
  styleScale: number
  coordinateScale: [number, number]
  styleDescription?: string
  openOnCreate: boolean
  onOpened: () => void
  readout?: LiveBlur
  onEdit?: (editing: boolean) => void
  onChange: (label: string, apply: (effect: Effect) => void) => void
  actions: ReactNode
  fillNotice?: ReactNode
}

export function BlurEffectPanel({
  effect, layer, label, sketchModes, blurStopIndex, onSelectBlurStop, styleScale, coordinateScale, styleDescription, openOnCreate,
  onOpened, readout, onEdit, onChange, actions, fillNotice,
}: Props) {
  const { tr, locale } = usePropertyText()
  const id = useId()
  const button = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const edit = useRef(onEdit)
  edit.current = onEdit
  const [open, setOpen] = useState(openOnCreate)
  const [presentation, setPresentation] = useState(0)
  const motion = isMotionZoomBlur(effect.kind)
  const zoom = effect.kind === 'zoom-blur'
  const gradient = effect.gradientBlur
  const hasHandles = effect.visible && !!(gradient || zoom)
  const hadHandles = useRef(false)

  useEffect(() => () => {
    if (hadHandles.current) edit.current?.(false)
  }, [])

  useEffect(() => {
    if (openOnCreate) {
      setOpen(true)
      onOpened()
    }
  }, [openOnCreate, onOpened])

  useEffect(() => {
    if (hadHandles.current !== (open && hasHandles)) {
      hadHandles.current = open && hasHandles
      edit.current?.(hadHandles.current)
    }
  }, [open, hasHandles])

  const close = (restoreFocus = false) => {
    edit.current?.(false)
    setOpen(false)
    setPresentation(value => value + 1)
    if (restoreFocus) button.current?.focus()
  }

  useLayoutEffect(() => {
    if (!open) return
    const panel = popup.current
    const trigger = button.current
    if (!panel || !trigger) return
    panel.showPopover?.()
    const position = () => {
      const box = trigger.getBoundingClientRect()
      panel.style.left = `${Math.max(8, box.left - panel.offsetWidth - 8)}px`
      panel.style.top = `${Math.max(8, Math.min(box.top, window.innerHeight - panel.offsetHeight - 8))}px`
    }
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Element) ||
          trigger.contains(event.target) || panel.contains(event.target) ||
          event.target.closest('[data-testid="blur-edit-handles"]')) return
      close()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // Canvas handles its own Escape while a drag is active, including rollback.
      if (panel.contains(document.activeElement)) {
        event.preventDefault()
        close(true)
      } else close()
    }
    position()
    const size = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(position)
    size?.observe(panel)
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', escape)
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      size?.disconnect()
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
      if (panel.hidePopover && panel.matches(':popover-open')) panel.hidePopover()
    }
  }, [open])

  const name = tr(label)
  const settings = tr(`${label} · 设置`)
  const radiusField = (label: string, value: number, change: (effect: Effect, value: number) => void) =>
    <UnitNumberField label={tr(label)} historyLabel={label} diagnosticFamily={2} unit="number"
      sliderLabel={motion || sketchModes ? '模糊强度滑块' : undefined} unitScale={styleScale} unitDescription={styleDescription} min={0} max={1000} value={value}
      onChange={number => onChange(label, draft => change(draft, number))} />
  const ramp = gradient?.sketch
  const activeStop = ramp ? Math.min(blurStopIndex ?? 0, ramp.stops.length - 1) : 0
  const rampMode = ramp?.shape ?? (gradient ? 'linear' : 'uniform')
  const addStop = (offset: number) => {
    let added: number | undefined
    onChange('添加模糊停靠点', draft => {
      const stops = draft.gradientBlur?.sketch?.stops
      if (stops) added = insertBlurStop(stops, offset)
    })
    if (added !== undefined) onSelectBlurStop?.(added)
  }
  return <div className="blur-effect">
    <div className="blur-effect-row">
      <button type="button" ref={button} className="blur-settings-trigger"
        aria-expanded={open} aria-haspopup="dialog" aria-controls={id} aria-label={settings}
        onClick={() => open ? close() : setOpen(true)}>
        {motion ? <Move size={14} /> : <Waves size={14} />}
        <span>{name}</span>
      </button>
      {actions}
    </div>
    {fillNotice}
    <div ref={popup} id={id} popover="manual" className="glass-settings-popover blur-settings-popover"
      role="dialog" aria-label={settings} hidden={!open}>
      <div className="glass-settings-header">
        <strong>{name}</strong>
        <button type="button" aria-label={tr('关闭')} onClick={() => close(true)}><X size={15} /></button>
      </div>
      <div key={presentation} className="blur-settings-body effect-fields">
        <div className="blur-settings-modes" role="group" aria-label={tr('模糊模式')}>
          {motion ? (['motion-blur', 'zoom-blur'] as const).map(kind =>
            <button type="button" key={kind} aria-pressed={effect.kind === kind} onClick={() =>
              onChange('模糊模式', draft => setMotionZoomMode(draft, kind))}>
              {kind === 'motion-blur' ? tr('运动') : locale === 'en' ? 'Zoom' : '缩放'}
            </button>
          ) : sketchModes ? (['uniform', 'linear', 'radial'] as const).map(mode =>
            <button type="button" key={mode} aria-pressed={rampMode === mode} onClick={() =>
              onChange('模糊模式', draft => setSketchBlurMode(draft, mode, layer.width, layer.height))}>
              {tr({ uniform: '均匀', linear: '线性渐进', radial: '径向渐进' }[mode])}
            </button>
          ) : ([false, true] as const).map(progressive =>
            <button type="button" key={String(progressive)} aria-pressed={!!gradient === progressive}
              disabled={!progressive && !!gradient && gradient.endCount * effect.radius > 1000}
              onClick={() => onChange('模糊模式', draft => setProgressiveMode(draft, progressive, layer.width, layer.height))}>
              {tr(progressive ? '渐进' : '均匀')}
            </button>
          )}
        </div>
        {ramp ? <>
          <div className="sketch-blur-ramp">
            <button type="button" aria-label={tr('反转模糊')} title={tr('反转模糊')} onClick={() => {
              onChange('反转模糊', draft => {
                const stops = draft.gradientBlur?.sketch?.stops
                if (stops) { stops.reverse(); for (const stop of stops) stop.offset = 1 - stop.offset }
              })
            }}><ArrowLeftRight size={14} /></button>
            <div className="sketch-blur-stop-track" role="group" aria-label={tr('模糊停靠点')} onClick={event => {
              const box = event.currentTarget.getBoundingClientRect()
              if (box.width > 0 && event.target === event.currentTarget) addStop(Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)))
            }}>
              {ramp.stops.map((stop, index) => (
                <button type="button" key={index}
                  style={{ left: Math.min(100, Math.max(0, (readout?.blurStopOffsets?.[index] ?? stop.offset) * 100)) + '%',
                    background: `color-mix(in srgb, var(--sketch-effect-accent, var(--workspace-accent)) ${stop.strength * 100}%, var(--workspace-panel))` }}
                  aria-label={`${tr('模糊停靠点')} ${index + 1}`}
                  aria-pressed={activeStop === index}
                  onClick={() => onSelectBlurStop?.(index)} />
              ))}
            </div>
            <button type="button" aria-label={tr('旋转模糊')} title={tr('旋转模糊')} onClick={() =>
              onChange('旋转模糊', draft => {
                const gradient = draft.gradientBlur
                if (!gradient) return
                const origin = ramp.shape === 'radial' ? gradient.start : [
                  (gradient.start[0] + gradient.end[0]) / 2, (gradient.start[1] + gradient.end[1]) / 2,
                ]
                if (!(layer.width > 0 && layer.height > 0)) return
                // Sketch rotates the normalized field. In a rectangular
                // layer one vertical unit is not one horizontal unit.
                const turn = ([x, y]: [number, number]): [number, number] =>
                  [origin[0] - (y - origin[1]) * layer.width / layer.height,
                    origin[1] + (x - origin[0]) * layer.height / layer.width]
                gradient.start = turn(gradient.start)
                gradient.end = turn(gradient.end)
              })}><RotateCw size={14} /></button>
          </div>
          {radiusField('模糊', effect.radius * ramp.stops[activeStop].strength, (draft, radius) => changeBlurStopRadius(draft, activeStop, radius))}
          <details className="blur-coordinates">
            <summary>{tr('端点坐标')}</summary>
            <NumberField label={tr('停靠点位置 %')} historyLabel="停靠点位置" unit="percent" min={0} max={100} step={.1}
              value={(readout?.blurStopOffsets?.[activeStop] ?? ramp.stops[activeStop].offset) * 100}
              onChange={value => onChange('停靠点位置', draft => {
                const stops = draft.gradientBlur?.sketch?.stops
                if (!stops?.[activeStop]) return
                stops[activeStop].offset = Math.max(stops[activeStop - 1]?.offset ?? 0, Math.min(stops[activeStop + 1]?.offset ?? 1, value / 100))
              })} />
            {ramp.shape === 'radial' && <NumberField label={tr('椭圆半径比')} historyLabel="椭圆半径比" min={0.001} max={1e6} step={.01} value={ramp.ellipse || 1}
              onChange={value => onChange('椭圆半径比', draft => { if (draft.gradientBlur?.sketch) draft.gradientBlur.sketch.ellipse = value })} />}
            <div className="sketch-blur-stop-actions">
              <button type="button" disabled={ramp.stops.length >= MAX_BLUR_STOPS} onClick={() => addStop(.5)}>{tr('添加模糊停靠点')}</button>
              <button type="button" disabled={ramp.stops.length <= 2} onClick={() => {
                onChange('删除模糊停靠点', draft => { draft.gradientBlur?.sketch?.stops.splice(activeStop, 1) })
                onSelectBlurStop?.(Math.min(activeStop, ramp.stops.length - 2))
              }}>{tr('删除模糊停靠点')}</button>
            </div>
          </details>
        </> : gradient ? <>
          {radiusField('起点强度', gradient.startCount * effect.radius, (draft, value) => setProgressiveRadius(draft, 'startCount', value))}
          {radiusField('终点强度', gradient.endCount * effect.radius, (draft, value) => setProgressiveRadius(draft, 'endCount', value))}
          <details className="blur-coordinates">
            <summary>{tr('端点坐标')}</summary>
            {(['start', 'end'] as const).flatMap(endpoint => ([0, 1] as const).map(axis => {
              const anchor = endpoint === 'start' ? '起点' : '终点'
              const coordinate = axis ? 'Y' : 'X'
              const label = `${anchor} ${coordinate}`
              const value = (readout?.gradient ?? gradient)[endpoint][axis]
              return <UnitNumberField key={label} label={`${tr(anchor)} ${coordinate}`}
                historyLabel={label} unit="number" diagnosticFamily={2} unitScale={coordinateScale[axis]}
                min={-1e7} max={1e7} value={value}
                onChange={number => onChange(label, draft => {
                  if (draft.gradientBlur) draft.gradientBlur[endpoint][axis] = number
                })} />
            }))}
            <label className="check-row">
              <input type="checkbox" checked={gradient.smooth} aria-label={tr('平滑渐变模糊')}
                onChange={event => onChange('平滑权重', draft => {
                  if (draft.gradientBlur) draft.gradientBlur.smooth = event.currentTarget.checked
                })} />
              {tr('平滑权重')}
            </label>
          </details>
        </> : zoom && effect.zoomBlur ? <>
          <NumberField label={tr('模糊')} historyLabel="缩放模糊强度" diagnosticFamily={2}
            sliderLabel="模糊强度滑块" unit="number" value={effect.zoomBlur.amount} min={0} max={1000}
            onChange={value => onChange('缩放模糊强度', draft => { if (draft.zoomBlur) draft.zoomBlur.amount = value })} />
          <details className="blur-coordinates">
            <summary>{tr('缩放模糊焦点')}</summary>
            {([0, 1] as const).map(axis => <NumberField key={axis} label={tr(axis ? '焦点 Y %' : '焦点 X %')}
              historyLabel="缩放模糊焦点" unit="number" diagnosticFamily={2} min={-1e8} max={1e8}
              value={(readout?.zoomCenter ?? effect.zoomBlur!.center)[axis] * 100}
              onChange={value => onChange('缩放模糊焦点', draft => { if (draft.zoomBlur) draft.zoomBlur.center[axis] = value / 100 })} />)}
          </details>
        </> : <>
          {radiusField('模糊', effect.radius, (draft, value) => { draft.radius = value })}
          {motion && <NumberField label={tr('角度')} historyLabel="运动模糊方向" unit="angle" diagnosticFamily={2}
            value={effect.motionAngle ?? 0} min={-1e7} max={1e7}
            onChange={value => onChange('运动模糊方向', draft => { draft.motionAngle = value })} />}
        </>}
        {sketchModes && effect.kind === 'background-blur'
          ? <NumberField label={tr('饱和度')} historyLabel="饱和度" unit="percent" diagnosticFamily={2}
              value={((effect.colorControls?.saturation ?? 1) - 1) * 100} min={-100} max={Math.max(100, ((effect.colorControls?.saturation ?? 1) - 1) * 100)}
              onChange={value => onChange('饱和度', draft => {
                draft.colorControls = { ...(draft.colorControls ?? defaultColorControls()), saturation: 1 + value / 100 }
              })} />
          : !motion && effect.colorControls && <NumberField label={tr('饱和度')} historyLabel="饱和度" unit="number"
          diagnosticFamily={2} value={effect.colorControls.saturation} min={0} max={4} step={0.05}
          onChange={value => onChange('饱和度', draft => { if (draft.colorControls) draft.colorControls.saturation = value })} />}
      </div>
    </div>
  </div>
}
