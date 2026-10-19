import { numericExpression, propertyUnit, type NumericUnit } from './numeric-expression'
import { useContext, useEffect, useRef } from 'react'
import { PendingEditContext } from './pending-edit-context'
import { pendingEditsChanged, registerPendingEdit } from './pending-edits'
export function NumberField({ label, value, onChange, min = -1e6, max = 1e6, step = 1, unit = propertyUnit(label) }: {
  label: string
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  unit?: NumericUnit
}) {
  const editor = useContext(PendingEditContext)
  const input = useRef<HTMLInputElement>(null), dirty = useRef(false), composing = useRef(false)
  const draft = useRef(String(value)), original = useRef(value), session = useRef(editor?.sessionGeneration)
  const changed = () => { if (editor) pendingEditsChanged(editor) }
  const finish = () => {
    if (!dirty.current && !composing.current) return true
    if (composing.current) return false
    let v: number
    try { v = numericExpression(draft.current, original.current, unit) } catch { v = NaN }
    if (!draft.current.trim() || !Number.isFinite(v) || v < min || v > max ||
      (editor && (editor.sessionGeneration !== session.current || value !== original.current))) {
      input.current?.setCustomValidity('请输入有效数值；若属性已变化，请按 Esc 取消后重试')
      input.current?.reportValidity()
      return false
    }
    if (v !== original.current) {
      const before = editor?.state.doc
      onChange(v)
      if (editor && editor.state.doc === before) return false
    }
    original.current = v
    dirty.current = false
    input.current?.setCustomValidity('')
    changed()
    return true
  }
  const scrub = useRef<{ pointer: number; x: number; base: number; session?: number; moved?: boolean } | null>(null)
  const applyScrub = (event: { pointerId: number; clientX: number; altKey: boolean; shiftKey: boolean }) => {
    const owner = scrub.current
    if (!owner || owner.pointer !== event.pointerId || (editor && editor.sessionGeneration !== owner.session)) return
    const delta = event.clientX - owner.x
    owner.moved ||= delta !== 0
    if (!owner.moved) return
    const next = delta === 0 ? owner.base : Math.min(max, Math.max(min, owner.base + delta * step * (event.altKey ? .1 : event.shiftKey ? 10 : 1)))
    onChange(next)
    if (input.current) input.current.value = String(next)
  }
  const stopScrub = (cancel: boolean) => {
    const owner = scrub.current; scrub.current = null
    if (owner && editor && editor.sessionGeneration === owner.session) {
      if (cancel) editor.cancel(); else editor.commit()
    }
  }
  useEffect(() => () => stopScrub(true), [editor])
  const commit = useRef(finish); commit.current = finish
  useEffect(() => editor ? registerPendingEdit(editor, {
    dirty: () => dirty.current || composing.current,
    commit: () => commit.current(),
  }) : undefined, [editor])
  useEffect(() => {
    if (!dirty.current && !composing.current) {
      original.current = value; draft.current = String(value)
      if (input.current) input.current.value = String(Number(value.toFixed(2)))
    }
  }, [value])
  return <label className="number-field">
    <span className="number-scrub" title="拖动调整数值；Shift 加速，Option 精细调整" tabIndex={0} role="button" aria-label={`拖动调整 ${label}`}
      onPointerDown={event => {
        if (event.button !== 0 || !event.isPrimary || composing.current || !finish() || editor?.interactionActive) return
        event.preventDefault(); event.stopPropagation(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId)
        scrub.current = { pointer: event.pointerId, x: event.clientX, base: original.current, session: editor?.sessionGeneration }
        editor?.begin(`调整 ${label}`)
      }}
      onPointerMove={applyScrub}
      onPointerUp={event => {
        if (scrub.current?.pointer !== event.pointerId) return
        applyScrub(event)
        stopScrub(false)
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      }} onPointerCancel={() => stopScrub(true)} onLostPointerCapture={() => stopScrub(true)}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); stopScrub(true) } }}
    >{label}</span>
    <input ref={input} aria-label={label} type="text" inputMode="decimal" role="spinbutton" aria-valuenow={value} aria-valuemin={min} aria-valuemax={max} title={String(value)} defaultValue={Number(value.toFixed(2))}
      onFocus={(e) => { if (!dirty.current) e.currentTarget.select() }}
      onChange={(e) => { draft.current = e.currentTarget.value; dirty.current = true; e.currentTarget.setCustomValidity(''); changed() }}
      onCompositionStart={() => { composing.current = true; changed() }}
      onCompositionEnd={(e) => { composing.current = false; draft.current = e.currentTarget.value; dirty.current = true; changed() }}
      onBlur={() => { finish() }}
      onKeyDown={(e) => {
        if (composing.current || e.nativeEvent.isComposing) return
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault()
          try {
            const next = Math.min(max, Math.max(min, numericExpression(draft.current, original.current, unit) + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : e.altKey ? .1 : 1)))
            draft.current = String(next); dirty.current = true; e.currentTarget.value = draft.current; changed()
          } catch { e.currentTarget.setCustomValidity('请先修正数值表达式') }
        }
        if (e.key === 'Escape') {
          e.preventDefault(); original.current = value; draft.current = String(value); dirty.current = false
          e.currentTarget.value = String(value); e.currentTarget.setCustomValidity(''); changed()
        }
        if (e.key === 'Enter' && finish()) e.currentTarget.blur()
      }}
    />
  </label>
}
