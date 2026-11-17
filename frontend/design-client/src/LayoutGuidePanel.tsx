import { useId, useLayoutEffect, useRef, useState } from 'react'
import { Columns3, Eye, EyeOff, Grid3X3, Minus, Plus, Rows3, X } from 'lucide-react'
import { ColorInput } from './ColorInput'
import { hasCanvasColorPicker } from './canvas-color-picker'
import type { Editor } from './engine'
import { NumberField } from './fields'
import { defaultLayoutGrid, MAX_LAYOUT_GRIDS, type DesignNode, type LayoutGrid } from './model'
import { commitPendingEdits } from './pending-edits'
import { usePropertyText } from './property-interface-messages'
import { propertyUnits } from './property-units'
import { UnitNumberField } from './UnitNumberField'

function GridFields({ grid, update, unitScale }: {
  grid: LayoutGrid; update: (patch: Partial<LayoutGrid>) => void; unitScale: number
}) {
  const { tr } = usePropertyText()
  return <>
    <label className="labeled-select">{tr('网格方向')}<select aria-label={tr('网格方向')} value={grid.axis}
      onChange={event => update({ axis: event.target.value as LayoutGrid['axis'] })}>
      <option value="column">{tr('列')}</option>
      <option value="row">{tr('行')}</option>
      <option value="uniform">{tr('方块')}</option>
    </select></label>
    <label className="labeled-select">{tr('网格对齐')}<select aria-label={tr('网格对齐')} value={grid.alignment ?? 'stretch'}
      onChange={event => {
        const alignment = event.target.value as NonNullable<LayoutGrid['alignment']>
        update(alignment === 'stretch'
          ? { alignment, sectionSize: undefined, count: grid.count || 12 }
          : { alignment, sectionSize: grid.sectionSize ?? 32 })
      }}>
      <option value="start">{tr('起点')}</option>
      <option value="center">{tr('居中')}</option>
      <option value="end">{tr('终点')}</option>
      <option value="stretch">{tr('拉伸')}</option>
    </select></label>
    <div className="field-grid">
      <NumberField historyLabel="数量" diagnosticFamily={2} unit="number"
        label={tr(grid.sectionSize === undefined ? '数量' : '数量（0 为自动）')} value={grid.count}
        min={grid.sectionSize === undefined ? 1 : 0} max={64} onChange={count => update({ count: Math.round(count) })} />
      {grid.sectionSize !== undefined && <UnitNumberField unitScale={unitScale}
        label={tr('区块尺寸')} value={grid.sectionSize} min={0.01} onChange={sectionSize => update({ sectionSize })} />}
      <UnitNumberField historyLabel="间距" unit="length" diagnosticFamily={2} unitScale={unitScale}
        label={tr('间距')} value={grid.gutter} min={0} max={1e5} onChange={gutter => update({ gutter })} />
      <UnitNumberField historyLabel="边距" unit="length" diagnosticFamily={2} unitScale={unitScale}
        label={tr('边距')} value={grid.margin} min={0} max={1e5} onChange={margin => update({ margin })} />
      <NumberField historyLabel="不透明度 %" diagnosticFamily={11} unit="percent" label={tr('不透明度 %')}
        value={grid.opacity * 100} min={0} max={100} onChange={v => update({ opacity: v / 100 })} />
    </div>
    <ColorInput label={tr('网格颜色')} value={grid.color} onChange={color => update({ color })} />
  </>
}

export function LayoutGuidePanel({ editor, frame, ids, compact = false }: {
  editor: Editor; frame: DesignNode; ids: string[]; compact?: boolean
}) {
  const { tr, locale } = usePropertyText()
  const grids = frame.layoutGrids ?? (frame.layoutGrid ? [frame.layoutGrid] : [])
  const units = propertyUnits(editor.state.doc, frame.id, editor.parentMap())
  const [active, setActive] = useState<{ index: number; trigger: HTMLButtonElement } | null>(null)
  const popover = useRef<HTMLDivElement>(null)
  const popoverId = useId()
  const grid = active ? grids[active.index] : undefined
  const hasGrid = !!grid
  const close = (restoreFocus: boolean) => {
    if (!commitPendingEdits(editor)) return
    setActive(null)
    if (restoreFocus) active?.trigger.focus({ preventScroll: true })
  }
  useLayoutEffect(() => {
    if (active && !hasGrid) {
      setActive(null)
      return
    }
    const panel = popover.current
    if (!active || !panel) return
    const { trigger } = active
    panel.showPopover?.()
    const place = () => {
      const rect = trigger.getBoundingClientRect()
      panel.style.left = `${Math.max(8, rect.left - panel.offsetWidth - 8)}px`
      panel.style.top = `${Math.max(8, Math.min(rect.top, innerHeight - panel.offsetHeight - 8))}px`
    }
    const outside = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element) || panel.contains(target) || trigger.contains(target)) return
      if (hasCanvasColorPicker(editor) && target.closest('[data-testid="canvas"]')) return
      if (commitPendingEdits(editor)) setActive(null)
    }
    place()
    panel.focus({ preventScroll: true })
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      if (panel.hidePopover && panel.matches(':popover-open')) panel.hidePopover()
    }
  }, [active, editor, hasGrid])
  const edit = (transform: (current: LayoutGrid[]) => LayoutGrid[], label: string) =>
    editor.updateProperties(ids, target => {
      if (target.kind !== 'frame') return
      const current = target.layoutGrids ?? (target.layoutGrid ? [target.layoutGrid] : [])
      const next = transform(current)
      delete target.layoutGrid
      if (next.length === 1 && next[0].alignment === undefined) {
        target.layoutGrid = next[0]
        delete target.layoutGrids
      } else if (next.length) target.layoutGrids = next
      else delete target.layoutGrids
    }, label)
  const update = (index: number, patch: Partial<LayoutGrid>) =>
    edit(current => current.map((value, i) => i === index ? { ...value, ...patch } : value), '修改布局网格')
  const remove = (index: number) => edit(current => current.filter((_, i) => i !== index), '移除布局网格')
  const addLabel = tr(compact ? '添加布局辅助线' : '添加布局网格')
  const add = <button type="button" aria-label={addLabel} title={addLabel} disabled={frame.locked || grids.length >= MAX_LAYOUT_GRIDS}
    onClick={() => edit(current => current.length < MAX_LAYOUT_GRIDS ? [...current, defaultLayoutGrid()] : current, '添加布局网格')}><Plus size={15} /></button>
  const fields = (value: LayoutGrid, index: number) => <GridFields grid={value}
    update={patch => update(index, patch)} unitScale={value.axis === 'row' ? units.y : units.x} />
  if (!compact) return <div className="layout-grid-list">
    <h4 id="layout-grid-settings" tabIndex={-1}>{tr('布局网格')} {add}</h4>
    {grids.map((value, index) => <fieldset key={index} className="layout-grid-editor" data-testid="layout-grid-editor" disabled={frame.locked}>
      <legend>{tr('布局网格')} {index + 1}</legend>
      <label className="check-row"><input type="checkbox" aria-label={tr('显示布局网格')}
        checked={value.visible} onChange={event => update(index, { visible: event.target.checked })} />{tr('显示网格')}</label>
      {fields(value, index)}
      <button type="button" onClick={() => remove(index)}>{tr('移除网格')}</button>
    </fieldset>)}
  </div>

  const settings = tr('布局辅助线设置')
  const formatter = new Intl.NumberFormat(locale === 'en' ? 'en' : 'zh-CN', { maximumFractionDigits: 2 })
  return <section className="layout-guide-section">
    <h3 id="layout-grid-settings" tabIndex={-1}>{tr('布局辅助线')} {add}</h3>
    {grids.map((value, index) => {
      const Icon = value.axis === 'column' ? Columns3 : value.axis === 'row' ? Rows3 : Grid3X3
      const type = tr(value.axis === 'column' ? '列' : value.axis === 'row' ? '行' : '网格')
      const count = value.axis === 'uniform' || !value.count ? '' : `${value.count} `
      const summary = `${count}${count && locale === 'en' ? type.toLowerCase() : type}${value.sectionSize === undefined ? '' : ` (${formatter.format(value.sectionSize)}px)`}`
      return <div key={index} className="layout-guide-row">
        <button type="button" className="layout-guide-trigger" aria-label={`${settings} · ${summary}`} aria-haspopup="dialog"
          aria-expanded={active?.index === index} aria-controls={active?.index === index ? popoverId : undefined}
          onClick={event => {
            if (active?.index === index) close(true)
            else if (commitPendingEdits(editor)) setActive({ index, trigger: event.currentTarget })
          }}><Icon size={15} /><span title={summary}>{summary}</span></button>
        <button type="button" aria-label={`${tr('显示布局网格')} · ${summary}`} aria-pressed={value.visible}
          disabled={frame.locked} onClick={() => update(index, { visible: !value.visible })}>{value.visible ? <Eye size={14} /> : <EyeOff size={14} />}</button>
        <button type="button" title={tr('移除网格')} aria-label={`${tr('移除网格')} · ${summary}`}
          disabled={frame.locked} onClick={() => remove(index)}><Minus size={15} /></button>
      </div>
    })}
    {active && grid && <div ref={popover} id={popoverId} popover="manual" role="dialog" tabIndex={-1}
      aria-label={settings} className="layout-guide-popover"
      onKeyDown={event => {
        if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); close(true) }
      }}>
      <div className="layout-guide-popover-heading">
        <strong>{settings}</strong>
        <button type="button" aria-label={tr('关闭')} onClick={() => close(true)}><X size={14} /></button>
      </div>
      <fieldset className="layout-grid-editor" data-testid="layout-grid-editor" disabled={frame.locked}>{fields(grid, active.index)}</fieldset>
    </div>}
  </section>
}
