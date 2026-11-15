import { useEffect, useId, useRef, useState } from 'react'
import { SlidersHorizontal, X } from 'lucide-react'
import { defaultColorControls, effect, type ColorControls, type DesignNode, type Effect } from './model'
import { NumberField } from './fields'
import { UnitNumberField } from './UnitNumberField'
import type { UiMode } from './interface-preference'
import { usePropertyText } from './property-interface-messages'

const sketchDepthScale = 16

export function createGlassEffect(mode: UiMode): Effect {
  const preset = effect('glass')
  if (mode === 'sketch') {
    return { ...preset, radius: 0, amount: 0, opacity: 1, glass: { ...preset.glass!, dispersion: 0 } }
  }
  return {
    ...preset, radius: 4, y: 4, opacity: 0.25,
    glass: { depth: 20, refraction: 0.8, dispersion: 0.5, lightAngle: -45, lightIntensity: 0.8 },
  }
}

/** The native actions make an opaque solid lens transmissive. The authored
 * fill stays in the layer and Undo restores it with the effect transaction. */
export function prepareGlassFill(node: DesignNode, mode: UiMode) {
  for (const fill of node.fills) {
    if (fill.kind !== 'solid' || !fill.visible || fill.opacity !== 1) continue
    if (mode === 'sketch') fill.visible = false
    else fill.opacity = 0.1
  }
}

type Glass = NonNullable<Effect['glass']>
type Props = {
  effect: Effect
  mode: UiMode
  styleScale: number
  styleDescription?: string
  documentSpace?: ColorControls['space']
  openOnCreate: boolean
  onOpened: () => void
  onChange: (apply: (effect: Effect) => void) => void
}

/** Both native apps place glass settings in a panel anchored to the effect. */
export function GlassEffectPanel({ effect: fx, mode, styleScale, styleDescription, documentSpace, openOnCreate, onOpened, onChange }: Props) {
  const { tr } = usePropertyText()
  const id = useId(), button = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null)
  const [settingsRevision, setSettingsRevision] = useState(0)
  const glass = fx.glass!
  const open = () => {
    const panel = popup.current
    const anchor = button.current?.getBoundingClientRect()
    if (!panel || !anchor || panel.matches(':popover-open')) return
    panel.showPopover()
    panel.style.left = `${Math.max(8, anchor.left - panel.offsetWidth - 8)}px`
    panel.style.top = `${Math.max(8, Math.min(anchor.top, window.innerHeight - panel.offsetHeight - 8))}px`
  }
  useEffect(() => {
    if (openOnCreate) { open(); onOpened() }
  }, [openOnCreate])
  const changeGlass = (key: keyof Glass, value: number) => onChange(effect => {
    if (!effect.glass) return
    if (key === 'splay' && value === 0) delete effect.glass.splay
    else effect.glass[key] = value
  })
  const settings = mode === 'sketch' ? [
    { key: 'refraction', label: '扭曲', factor: 100 },
    { key: 'depth', label: '深度', factor: 100 / sketchDepthScale },
    { key: 'dispersion', label: '色差', factor: 100 },
  ] as const : [
    { key: 'lightAngle', label: '光线角度', factor: 1 },
    { key: 'lightIntensity', label: '照明 %', factor: 100 },
    { key: 'refraction', label: '折射 %', factor: 100 },
    { key: 'depth', label: '深度', factor: 1 },
    { key: 'dispersion', label: '色散 %', factor: 100 },
  ] as const
  const frostLabel = mode === 'sketch' ? '模糊' : '磨砂'
  return <>
    <button ref={button} type="button" className="glass-settings-trigger"
      aria-haspopup="dialog" aria-controls={id} aria-label={tr('玻璃设置')} title={tr('玻璃设置')}
      onClick={() => popup.current?.matches(':popover-open') ? popup.current.hidePopover() : open()}>
      <SlidersHorizontal size={15} />
    </button>
    <div ref={popup} id={id} popover="auto" className="glass-settings-popover" role="dialog" aria-label={tr('玻璃设置')}
      onToggle={event => {
        // A dismissed popover must release any incomplete field draft.
        if (!event.currentTarget.matches(':popover-open')) setSettingsRevision(value => value + 1)
      }}>
      <div className="glass-settings-header">
        <strong>{tr('玻璃')}</strong>
        <button type="button" aria-label={tr('关闭')} onClick={() => {
          popup.current?.hidePopover()
          button.current?.focus()
        }}><X size={15}/></button>
      </div>
      <div key={settingsRevision} className="field-grid glass-fields effect-fields">
        {settings.map(({ key, label, factor }) => {
          const angle = key === 'lightAngle'
          const distance = mode === 'figma' && key === 'depth'
          return <UnitNumberField key={key} label={tr(label)} historyLabel={label}
            unit={angle ? 'angle' : distance ? 'length' : key === 'lightIntensity' ? 'percent' : 'number'}
            unitScale={distance ? styleScale : 1}
            unitDescription={distance ? styleDescription : undefined} diagnosticFamily={2}
            value={glass[key] * factor} min={angle ? -360 : 0} max={distance ? 1000 : angle ? 360 : 100}
            onChange={value => changeGlass(key, value / factor)}/>
        })}
        <UnitNumberField label={tr(frostLabel)} historyLabel={frostLabel} diagnosticFamily={2}
          unit="length" unitDescription={styleDescription} unitScale={styleScale} value={fx.radius}
          min={0} max={1000} onChange={value => onChange(effect => { effect.radius = value })}/>
        {mode === 'figma' ? <>
          <NumberField label={tr('光线扩散')} historyLabel="光线扩散" diagnosticFamily={2}
            value={(glass.splay ?? 0) * 100} min={0} max={100} onChange={value => changeGlass('splay', value / 100)}/>
          <UnitNumberField label={tr('倒角宽度')} historyLabel="倒角宽度" diagnosticFamily={2}
            unit="length" unitScale={styleScale} unitDescription={styleDescription}
            value={glass.bevelSize ?? 1} min={0.001} max={1000} onChange={value => changeGlass('bevelSize', value)}/>
        </> : <>
          {(['saturation','brightness'] as const).map(key => {
            const label = key === 'saturation' ? '饱和度 %' : '亮度 %'
            const neutral = key === 'saturation' ? 1 : 0
            return <NumberField key={key} label={tr(label)} historyLabel={label} diagnosticFamily={2}
              unit="percent" min={-100} max={100} value={((fx.colorControls?.[key] ?? neutral) - neutral) * 100}
              onChange={value => onChange(effect => {
                effect.colorControls = { ...defaultColorControls(), space: documentSpace, ...effect.colorControls, [key]: value / 100 + neutral }
              })}/>
          })}
          <label className="glass-light-toggle">
            <input type="checkbox" checked={glass.lightIntensity !== 0}
              onChange={event => changeGlass('lightIntensity', event.currentTarget.checked ? 0.5 : 0)}/>
            {tr('镜面高光')}
          </label>
        </>}
      </div>
    </div>
  </>
}
