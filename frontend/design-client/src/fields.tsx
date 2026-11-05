import { formatAngleDegrees } from './selection-handles'
import { usePropertyText } from './property-interface-messages'
import { createInputDiagnostics, dimensionExpectation, numericInputFamily, InputPhase } from './input-diagnostics'
import { numericExpression, propertyUnit, type NumericUnit } from './numeric-expression'
import { useContext, useEffect, useMemo, useRef } from 'react'
import { PendingEditContext } from './pending-edit-context'
import { pendingEditsChanged, registerPendingEdit } from './pending-edits'
export function NumberField({ label, value, onChange, min = -1e6, max = 1e6, step = 1, unit = propertyUnit(label), unitDescription, diagnosticFamily, historyLabel = label, formatValue, caption }: {
  label: string
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  unitDescription?: string
  /** Stable semantic label for history; independent from localized presentation. */
  historyLabel?: string
  diagnosticFamily?: number
  unit?: NumericUnit
  /** Display-only. The committed number stays full precision until the field edits it. */
  formatValue?: (value: number) => string
  /** Short mark shown in the field. `label` remains the accessible name. */
  caption?: string
}) {
  const { locale, tr } = usePropertyText()
  const editor = useContext(PendingEditContext)
  const family = diagnosticFamily ?? numericInputFamily(label)
  const diagnostic = useMemo(() => createInputDiagnostics(editor, family), [editor, family])
  useEffect(() => () => diagnostic.dispose(), [diagnostic])
  const input = useRef<HTMLInputElement>(null), dirty = useRef(false), composing = useRef(false)
  useEffect(() => {
    if (input.current?.validity.customError) input.current.setCustomValidity(tr('请输入有效数值；若属性已变化，请按 Esc 取消后重试'))
  }, [tr])
  const draft = useRef(String(value)), original = useRef(value), session = useRef(editor?.sessionGeneration)
  // A retained field belongs to the target at first input, not its mount session.
  // Locale changes do not alter this identity; equal values on another target do.
  const target = () => editor ? JSON.stringify([editor.state.doc.id, editor.state.page, editor.state.selection]) : ''
  const renderedSession = editor?.sessionGeneration, renderedTarget = target()
  const draftRevision = useRef(0), committingValue = useRef<number | null>(null)
  const draftTarget = useRef(renderedTarget)
  const ownsDraft = () => !editor || (editor.sessionGeneration === session.current && target() === draftTarget.current)
  const startDraft = () => {
    if (dirty.current || composing.current) return
    // Bind the callback's rendered target, never a newer live selection.
    session.current = renderedSession
    draftTarget.current = renderedTarget
    original.current = committingValue.current ?? value
    draft.current = String(original.current)
  }
  const changed = () => { if (editor) pendingEditsChanged(editor) }
  const finish = () => {
    if (!dirty.current && !composing.current) return true
    if (composing.current) return false
    diagnostic.start()
    let v: number
    try { v = numericExpression(draft.current, original.current, unit) } catch { v = NaN }
    if (!draft.current.trim() || !Number.isFinite(v) || v < min || v > max ||
      (editor && (!ownsDraft() || value !== original.current))) {
      diagnostic.valid(false)
      input.current?.setCustomValidity(tr('请输入有效数值；若属性已变化，请按 Esc 取消后重试'))
      input.current?.reportValidity()
      return false
    }
    diagnostic.valid(true)
    const changedValue = v !== original.current
    const compare = dimensionExpectation(editor, family, v)
    const revision = draftRevision.current, previousOriginal = original.current
    const previousDraft = draft.current, ownerSession = session.current, ownerTarget = draftTarget.current
    // Retire this draft before onChange publishes synchronously. A subscriber
    // may type another draft into this same DOM input while the commit returns.
    original.current = v; dirty.current = false
    if (changedValue) {
      const before = editor?.state.doc
      committingValue.current = v
      try { onChange(v) } finally { committingValue.current = null }
      if (editor && editor.state.doc === before) {
        if (draftRevision.current === revision) {
          original.current = previousOriginal; draft.current = previousDraft; dirty.current = true
        }
        diagnostic.finish(false, false); return false
      }
    }
    diagnostic.finish(changedValue, !!editor || !changedValue, compare())
    if (draftRevision.current !== revision || (editor &&
      (editor.sessionGeneration !== ownerSession || target() !== ownerTarget))) return false
    input.current?.setCustomValidity('')
    committingValue.current = v
    try { changed() } finally { committingValue.current = null }
    // Pending-edit listeners are synchronous too; they may own a fresh draft
    // after the commit. Do not let this old Enter blur or submit that input.
    return draftRevision.current === revision && !dirty.current && !composing.current &&
      (!editor || (editor.sessionGeneration === ownerSession && target() === ownerTarget))
  }
  const formatRef = useRef(formatValue)
  formatRef.current = formatValue
  const scrub = useRef<{ pointer: number; x: number; base: number; session?: number; moved?: boolean } | null>(null)
  const applyScrub = (event: { pointerId: number; clientX: number; altKey: boolean; shiftKey: boolean }) => {
    const owner = scrub.current
    if (!owner || owner.pointer !== event.pointerId || (editor && editor.sessionGeneration !== owner.session)) return
    const delta = event.clientX - owner.x
    owner.moved ||= delta !== 0
    if (!owner.moved) return
    const next = delta === 0 ? owner.base : Math.min(max, Math.max(min, owner.base + delta * step * (event.altKey ? .1 : event.shiftKey ? 10 : 1)))
    onChange(next)
    if (input.current) input.current.value = shown(next)
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
  const shown = (next: number) => formatRef.current
    ? formatRef.current(next)
    : unit === 'angle' ? formatAngleDegrees(next) : String(Number(next.toFixed(2)))
  useEffect(() => {
    if (!dirty.current && !composing.current) {
      original.current = value; draft.current = String(value)
      if (input.current) input.current.value = shown(value)
    }
  }, [value])
  return <label className="number-field">
    <span className="number-scrub" title={`${label}: ${tr("拖动调整数值；Shift 加速，Option 精细调整")}`} tabIndex={0} role="button" aria-label={locale === 'en' ? `Adjust ${label} by dragging` : `拖动调整 ${label}`} aria-description={unitDescription ? `${tr('拖动调整数值；Shift 加速，Option 精细调整')}；${unitDescription}` : undefined}
      onPointerDown={event => {
        if (event.button !== 0 || !event.isPrimary || composing.current || !finish() || editor?.interactionActive) return
        event.preventDefault(); event.stopPropagation(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId)
        scrub.current = { pointer: event.pointerId, x: event.clientX, base: original.current, session: editor?.sessionGeneration }
        editor?.begin(`调整 ${historyLabel}`)
        diagnostic.event(InputPhase.scrub)
      }}
      onPointerMove={applyScrub}
      onPointerUp={event => {
        if (scrub.current?.pointer !== event.pointerId) return
        applyScrub(event)
        stopScrub(false)
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      }} onPointerCancel={() => stopScrub(true)} onLostPointerCapture={() => stopScrub(true)}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); stopScrub(true) } }}
    >{caption ?? label}{unitDescription && <small title={unitDescription}>＊</small>}</span>
    <input ref={input} aria-label={label} aria-description={unitDescription} type="text" inputMode="decimal" role="spinbutton" aria-valuenow={value} aria-valuemin={min} aria-valuemax={max} title={unitDescription ? `${value}；${unitDescription}` : shown(value)} defaultValue={shown(value)}
      onFocus={(e) => { diagnostic.event(InputPhase.focus); if (!dirty.current) e.currentTarget.select() }}
      onChange={(e) => { startDraft(); draftRevision.current++; diagnostic.start(); draft.current = e.currentTarget.value; dirty.current = true; e.currentTarget.setCustomValidity(''); changed() }}
      onCompositionStart={() => { startDraft(); draftRevision.current++; diagnostic.start(); diagnostic.event(InputPhase.compositionStart); composing.current = true; changed() }}
      onCompositionEnd={(e) => { if (!composing.current) return; draftRevision.current++; diagnostic.event(InputPhase.compositionEnd); composing.current = false; draft.current = e.currentTarget.value; dirty.current = true; changed() }}
      onBlur={() => { diagnostic.event(InputPhase.blur); finish() }}
      onKeyDown={(e) => {
        if (composing.current || e.nativeEvent.isComposing) return
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault()
          startDraft()
          draftRevision.current++
          diagnostic.start()
          try {
            const next = Math.min(max, Math.max(min, numericExpression(draft.current, original.current, unit) + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : e.altKey ? .1 : 1)))
            draft.current = shown(next); dirty.current = true; e.currentTarget.value = draft.current; changed()
          } catch { e.currentTarget.setCustomValidity(tr('请先修正数值表达式')) }
        }
        if (e.key === 'Escape') {
          e.preventDefault(); diagnostic.cancel(); original.current = value; draft.current = String(value); dirty.current = false
          e.currentTarget.value = String(value); e.currentTarget.setCustomValidity(''); changed()
        }
        if (e.key === 'Enter' && finish()) e.currentTarget.blur()
      }}
    />
    {unit === 'percent' && <span className="number-unit" aria-hidden="true">%</span>}
  </label>
}
