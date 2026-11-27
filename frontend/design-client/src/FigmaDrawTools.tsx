import { CodeXml, Frame, PenLine, Pencil } from 'lucide-react'
import { PendingEditContext } from './pending-edit-context'
import { NumberField } from './fields'
import type { Editor } from './engine'
import { useInterfacePreferences } from './interface-preference'
import { setFigmaDevMode, useFigmaDevMode } from './figma-dev-mode'
import { commitPendingEdits } from './pending-edits'

export function FigmaDevModeToggle({ editor, disabled }: { editor: Editor; disabled: boolean }) {
  const { locale } = useInterfacePreferences()
  const dev = useFigmaDevMode()
  const label = locale === 'en' ? 'Dev Mode' : '开发模式'
  return <button type="button" data-testid="dev-mode-toggle" aria-label={label}
    aria-pressed={dev} aria-keyshortcuts="Shift+D" data-tooltip={`${label} (Shift+D)`}
    disabled={disabled} onClick={() => {
      if (commitPendingEdits(editor)) setFigmaDevMode(!dev)
    }}><CodeXml size={17} aria-hidden="true" /></button>
}

export function FigmaToolbeltMode({ draw, onChange }: { draw: boolean; onChange: (draw: boolean) => boolean }) {
  const { locale } = useInterfacePreferences()
  const en = locale === 'en'
  return <div className="figma-toolbelt-mode" role="radiogroup" aria-label={en ? 'Toolbelt Mode' : '工具带模式'}
    onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      event.stopPropagation()
      const next = event.key === 'Home' ? true : event.key === 'End' ? false : !draw
      if (onChange(next)) event.currentTarget.querySelectorAll('button')[next ? 0 : 1]?.focus()
    }}>
    {([true, false] as const).map(value => {
      const label = value ? (en ? 'Draw' : '绘制') : (en ? 'Design' : '设计')
      const Icon = value ? PenLine : Frame
      return <button type="button" key={String(value)} role="radio" aria-checked={draw === value} aria-label={label}
        data-tooltip={label} tabIndex={draw === value ? 0 : -1} onClick={() => onChange(value)}><Icon size={18} aria-hidden="true" /></button>
    })}
  </div>
}

export function DrawPencilToolbar({ editor }: { editor: Editor }) {
  const { locale } = useInterfacePreferences()
  const label = (zh: string, en: string) => locale === 'en' ? en : zh
  const pencil = editor.state.pencil
  const updateWidth = (width: number) => editor.set({ pencil: { ...editor.state.pencil, width } })
  return <div className="draw-pencil-tools" role="group" aria-label={label('铅笔工具栏', 'Pencil toolbar')}>
    <Pencil size={15} aria-hidden="true" />
    <label className="draw-pencil-color" title={label('描边颜色', 'Stroke color')}>
      <input type="color" aria-label={label('描边颜色', 'Stroke color')}
        value={/^#[0-9a-f]{6}$/i.test(pencil.color) ? pencil.color : '#000000'}
        onChange={event => editor.set({ pencil: { ...editor.state.pencil, color: event.target.value } })} />
    </label>
    <PendingEditContext.Provider value={null}>
      <NumberField label={label('描边粗细', 'Stroke weight')} value={pencil.width} unit="number"
        min={0.25} max={256} step={0.25} onChange={updateWidth} />
    </PendingEditContext.Provider>
    <input type="range" min={0.25} max={64} step={0.25} value={Math.min(64, pencil.width)}
      aria-label={label('描边粗细滑块', 'Stroke weight slider')} onChange={event => updateWidth(event.target.valueAsNumber)} />
  </div>
}
