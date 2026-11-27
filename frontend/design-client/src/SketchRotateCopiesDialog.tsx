import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Editor } from './engine'
import { useInterfacePreferences } from './interface-preference'
import { modalKeyDown, useModalOwnership } from './modal-keyboard'
import {
  applySketchRotateCopies,
  bindRotateCopiesDialog,
  DEFAULT_ROTATE_COPIES,
  MAX_ROTATE_COPIES,
  rotateCopiesTargetIsCurrent,
  validRotateCopies,
  type SketchRotateCopiesTarget,
} from './sketch-rotate-copies'
import './frame-presets.css'

export function SketchRotateCopiesDialog({ editor }: { editor: Editor }) {
  const [target, setTarget] = useState<SketchRotateCopiesTarget | null>(null)
  useEffect(() => bindRotateCopiesDialog(editor, setTarget), [editor])
  return target && <RotateCopies editor={editor} target={target} onClose={() => setTarget(null)} />
}

function RotateCopies({ editor, target, onClose }: { editor: Editor; target: SketchRotateCopiesTarget; onClose: () => void }) {
  const { locale } = useInterfacePreferences()
  const text = (zh: string, en: string) => locale === 'en' ? en : zh
  const title = text('旋转副本', 'Rotate Copies')
  const dialog = useRef<HTMLElement>(null), first = useRef<HTMLInputElement>(null)
  useModalOwnership(dialog, first)
  const [raw, setRaw] = useState(String(DEFAULT_ROTATE_COPIES))
  const [failure, setFailure] = useState('')
  const copies = Number(raw)
  const current = rotateCopiesTargetIsCurrent(editor, target)
  const valid = current && validRotateCopies(copies)
  const validation = !current ? text('选区已变化，请重新打开旋转副本。', 'The selection changed. Reopen Rotate Copies.')
    : !valid ? text(`请输入 1–${MAX_ROTATE_COPIES} 之间的副本数量。`, `Enter a copy count from 1 to ${MAX_ROTATE_COPIES}.`)
      : failure
  return createPortal(<div className="frame-preset-backdrop" onPointerDown={event => {
    event.stopPropagation()
    if (event.target === event.currentTarget) onClose()
  }}>
    <section ref={dialog} tabIndex={-1} className="frame-preset-panel sketch-replacement-panel" role="dialog"
      aria-modal="true" aria-label={title} onKeyDown={event => modalKeyDown(event, onClose)}>
      <header><strong>{title}</strong><button type="button" onClick={onClose}>{text('取消', 'Cancel')}</button></header>
      <form noValidate onSubmit={event => {
        event.preventDefault()
        if (!current || !valid) return
        const result = applySketchRotateCopies(editor, target, copies)
        if (result?.status === 'committed' || result?.status === 'unchanged') onClose()
        else setFailure(result?.status === 'rejected' ? result.message : text('无法旋转副本。', 'Could not rotate copies.'))
      }}>
        <p>{text('创建要围绕中心点拷贝的图层数量。', 'Create copies of the layer rotated around its center point.')}</p>
        <label>{text('副本数量：', 'Copies:')}
          <input ref={first} type="number" min={1} max={MAX_ROTATE_COPIES} step={1} aria-label={text('副本数量', 'Copies')}
            value={raw} disabled={!current} onChange={event => { setRaw(event.target.value); setFailure('') }} />
        </label>
        {validation ? <p role="alert">{validation}</p>
          : <p role="status">{text(`将生成共 ${copies + 1} 个图层。`, `This creates ${copies + 1} layers in total.`)}</p>}
        <button type="submit" disabled={!valid}>{text('旋转', 'Rotate')}</button>
      </form>
    </section>
  </div>, document.body)
}