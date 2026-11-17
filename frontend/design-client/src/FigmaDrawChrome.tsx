import type { ReactNode } from 'react'
import { canvasText } from './canvas-interface-messages'
import type { GlyphIcon } from './chrome-icons'
import type { Editor, Tool } from './engine'
import { NumberField } from './fields'
import type { FigmaWorkspaceMode } from './figma-workspace-mode'
import type { PencilSettings } from './freehand'
import { useInterfacePreferences } from './interface-preference'
import { usePropertyText } from './property-interface-messages'

const modes = ['design', 'draw'] as const
const drawToolIds = ['select', 'pen', 'pencil', 'brush'] as const
const pencilCaps = [
  ['butt', '无端点'],
  ['square', '端点方形'],
  ['round', '端点圆形'],
] as const

function DesignModeIcon() {
  return <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
    <rect x="2.2" y="2.2" width="8.6" height="8.6" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <path d="M10.4 10.2 L15.2 15 M12.4 15.1 H15.2 V12.3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}

function DrawModeIcon() {
  return <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
    <path d="M11.1 2.8 L15.2 6.9 L6.6 15.5 H2.5 V11.4 Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    <path d="M9.4 4.5 L13.5 8.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
}

/** Bottom Design / Draw radios for the Figma layout. Sketch does not render them. */
export function FigmaWorkspaceModeSwitch({ mode, disabled, onChange }: {
  mode: FigmaWorkspaceMode
  disabled?: boolean
  onChange: (mode: FigmaWorkspaceMode) => void
}) {
  const { locale, uiMode } = useInterfacePreferences()
  if (uiMode !== 'figma') return null
  const text = canvasText[locale]
  const choose = (next: FigmaWorkspaceMode) => { if (!disabled) onChange(next) }
  return <div className="figma-workspace-mode" role="radiogroup" aria-label={text.workspaceMode}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
      const index = modes.indexOf(mode)
      const next = event.key === 'Home' ? 'design'
        : event.key === 'End' ? 'draw'
        : event.key === 'ArrowRight' || event.key === 'ArrowDown' ? modes[(index + 1) % modes.length]
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? modes[(index - 1 + modes.length) % modes.length]
        : null
      if (!next) return
      event.preventDefault()
      event.stopPropagation()
      choose(next)
      event.currentTarget.querySelector<HTMLButtonElement>(`[data-workspace-mode="${next}"]`)?.focus()
    }}>
    <ModeButton mode="design" selected={mode === 'design'} disabled={disabled} label="Design" tooltip={text.designMode} onChoose={choose} icon={<DesignModeIcon />} />
    <ModeButton mode="draw" selected={mode === 'draw'} disabled={disabled} label="Draw" tooltip={text.drawMode} onChoose={choose} icon={<DrawModeIcon />} />
  </div>
}

function ModeButton({ mode, selected, disabled, label, tooltip, onChoose, icon }: {
  mode: FigmaWorkspaceMode
  selected: boolean
  disabled?: boolean
  label: string
  tooltip: string
  onChoose: (mode: FigmaWorkspaceMode) => void
  icon: ReactNode
}) {
  return <button type="button" role="radio" data-workspace-mode={mode} aria-checked={selected} aria-label={label}
    tabIndex={selected ? 0 : -1} disabled={disabled} className={selected ? 'active' : ''}
    data-tooltip={tooltip} title={tooltip} onClick={() => onChoose(mode)}>{icon}</button>
}

type DrawToolItem = { id: Tool; label: string; key: string; icon: GlyphIcon }

/** Pen, pencil, and brush replace the design tool groups. Brush type lists stay out of this strip. */
export function FigmaDrawToolstrip({ editor, tool, pencil, brush, tools, disabled, onTool }: {
  editor: Editor
  tool: Tool
  pencil: PencilSettings
  brush: PencilSettings
  tools: readonly DrawToolItem[]
  disabled?: boolean
  onTool: (tool: Tool) => void
}) {
  const { locale, uiMode } = useInterfacePreferences()
  if (uiMode !== 'figma') return null
  const text = canvasText[locale]
  const items = drawToolIds.map(id => tools.find(item => item.id === id)).filter((item): item is DrawToolItem => !!item)
  const freehand = tool === 'pencil' || tool === 'brush' ? tool : null
  return <>
    <div className="tool-group" role="group" aria-label={text.drawTools} data-draw-tools="true">
      {items.map(item => {
        const Icon = item.icon
        const shortcut = item.key ? ` (${item.key})` : ''
        return <button type="button" key={item.id} disabled={disabled} aria-label={item.label} aria-pressed={tool === item.id}
          className={tool === item.id ? 'active' : ''} data-tooltip={`${item.label}${shortcut}`}
          onClick={() => onTool(item.id)}><Icon size={18} /></button>
      })}
    </div>
    {freehand && <DrawToolControls editor={editor} tool={freehand} settings={freehand === 'brush' ? brush : pencil} />}
  </>
}

function DrawToolControls({ editor, tool, settings }: { editor: Editor; tool: 'pencil' | 'brush'; settings: PencilSettings }) {
  const { locale } = useInterfacePreferences()
  const { tr } = usePropertyText()
  const text = canvasText[locale]
  const patch = (next: Partial<PencilSettings>) => {
    if (tool === 'pencil') editor.set({ pencil: { ...editor.state.pencil, ...next } })
    else editor.set({ brush: { ...editor.state.brush, ...next } })
  }
  return <div className="pencil-controls draw-tool-controls" data-draw-toolstrip={tool} role="group"
    aria-label={tool === 'pencil' ? text.pencilToolstrip : text.brushToolstrip}
    onKeyDown={event => { if ((event.target as Element).closest('input, textarea, select')) event.stopPropagation() }}>
    <input type="range" aria-label={tool === 'pencil' ? text.pencilWidthSlider : text.brushWidthSlider}
      min={0.5} max={200} step={0.5} value={settings.width}
      onChange={event => {
        const width = Number(event.target.value)
        if (Number.isFinite(width)) patch({ width })
      }} />
    <NumberField label={text.brushWidth} historyLabel="笔宽" unit="length" value={settings.width} min={0.5} max={200} step={0.5}
      onChange={width => patch({ width })} />
    <NumberField label={text.brushSmoothing} historyLabel="平滑" value={settings.smoothing} min={0.1} max={5} step={0.1}
      onChange={smoothing => patch({ smoothing })} />
    <input type="color" aria-label={text.brushColor} value={settings.color}
      onChange={event => patch({ color: event.target.value })} />
    {tool === 'brush' && <label>
      <input type="checkbox" aria-label={text.brushPressure} checked={settings.pressure}
        onChange={event => patch({ pressure: event.target.checked })} />
      {text.brushPressure}
    </label>}
    {tool === 'pencil' && <div className="pencil-cap-choices" role="radiogroup" aria-label={tr('描边')}>
      {pencilCaps.map(([value, label]) => <button key={value} type="button" role="radio" aria-checked={(settings.cap ?? 'round') === value}
        aria-label={tr(label)} onClick={() => { if ((settings.cap ?? 'round') !== value) patch({ cap: value }) }}>{tr(label)}</button>)}
    </div>}
  </div>
}
