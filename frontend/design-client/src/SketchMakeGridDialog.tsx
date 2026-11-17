import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { Editor } from './engine'
import { useInterfacePreferences } from './interface-preference'
import { modalKeyDown, useModalOwnership } from './modal-keyboard'
import { applySketchGrid, bindMakeGridDialog, makeGridTargetIsCurrent, MAX_GRID_CELLS, validMakeGridOptions, type MakeGridTarget } from './sketch-make-grid'
import './frame-presets.css'

export function SketchMakeGridDialog({ editor }: { editor: Editor }) {
  const [target, setTarget] = useState<MakeGridTarget | null>(null)
  useEffect(() => bindMakeGridDialog(editor, setTarget), [editor])
  return target && <GridSettings editor={editor} target={target} onClose={() => setTarget(null)} />
}

function GridSettings({ editor, target, onClose }: { editor: Editor; target: MakeGridTarget; onClose: () => void }) {
  const { locale } = useInterfacePreferences()
  const label = (zh: string, en: string) => locale === 'en' ? en : zh
  const title = label('制作网格', 'Make Grid')
  const dialog = useRef<HTMLElement>(null), first = useRef<HTMLInputElement>(null)
  useSyncExternalStore(editor.subscribe, editor.snapshot)
  useModalOwnership(dialog, first)
  const { existing, cells } = target.source
  const [fields, setFields] = useState(() => {
    const rows = Math.max(2, existing.rows), columns = Math.max(2, existing.columns)
    const expand = rows * columns <= MAX_GRID_CELLS
    return { rows: String(expand ? rows : existing.rows), columns: String(expand ? columns : existing.columns),
      gapX: String(existing.gapX), gapY: String(existing.gapY) }
  })
  const [failure, setFailure] = useState('')
  const number = (value: string) => value.trim() ? Number(value) : NaN
  const options = { rows: number(fields.rows), columns: number(fields.columns), gapX: number(fields.gapX), gapY: number(fields.gapY) }
  const current = makeGridTargetIsCurrent(editor, target)
  const valid = validMakeGridOptions(target, options)
  const added = options.rows * options.columns - cells.length
  const validation = !current ? label('选区已变化，请重新打开制作网格。', 'The selection changed. Reopen Make Grid.') : !valid
    ? label(`请保留已有行列，输入非负间距。网格最多 ${MAX_GRID_CELLS} 格。`,
      `Keep the existing rows and columns and enter nonnegative gaps. The grid can have up to ${MAX_GRID_CELLS} cells.`)
    : failure

  return createPortal(<div className="frame-preset-backdrop" onPointerDown={event => {
    event.stopPropagation()
    if (event.target === event.currentTarget) onClose()
  }}>
    <section ref={dialog} tabIndex={-1} className="frame-preset-panel sketch-replacement-panel" role="dialog"
      aria-modal="true" aria-label={title} onKeyDown={event => modalKeyDown(event, onClose)}>
      <header><strong>{title}</strong><button type="button" onClick={onClose}>{label('取消', 'Cancel')}</button></header>
      <form noValidate onSubmit={event => {
        event.preventDefault()
        if (!current || !valid) return
        const result = applySketchGrid(editor, target, options)
        if (result?.status === 'committed' || result?.status === 'unchanged') onClose()
        else setFailure(result?.status === 'rejected' ? result.message : label('无法制作网格。', 'Could not make the grid.'))
      }}>
        {([
          ['rows', label('行数', 'Rows'), existing.rows, '1'],
          ['columns', label('列数', 'Columns'), existing.columns, '1'],
          ['gapX', label('水平间距', 'Horizontal gap'), 0, 'any'],
          ['gapY', label('垂直间距', 'Vertical gap'), 0, 'any'],
        ] as const).map(([key, name, min, step]) => <label key={key}>{name}
          <input ref={key === 'rows' ? first : undefined} type="number" min={min} step={step}
            value={fields[key]} disabled={!current} onChange={event => {
              const value = event.target.value
              setFields(previous => ({ ...previous, [key]: value }))
              setFailure('')
            }} />
        </label>)}
        {validation ? <p role="alert">{validation}</p> : <p role="status">{label(`新增 ${added} 个副本`, `${added} new copies`)}</p>}
        <button type="submit" disabled={!current || !valid}>{label('生成网格', 'Create Grid')}</button>
      </form>
    </section>
  </div>, document.body)
}
