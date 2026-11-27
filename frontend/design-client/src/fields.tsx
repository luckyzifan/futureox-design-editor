import { formatAngleDegrees } from './selection-handles'
import { usePropertyText } from './property-interface-messages'
import { createInputDiagnostics, dimensionExpectation, numericInputFamily, InputPhase } from './input-diagnostics'
import { propertyExpression, propertyUnit, type NumericUnit } from './numeric-expression'
import { useContext, useEffect, useMemo, useRef } from 'react'
import { PendingEditContext } from './pending-edit-context'
import { pendingEditsChanged, registerPendingEdit } from './pending-edits'
import { interfacePreference } from './interface-preference'
import { shortcutPlatform } from './shortcut-profiles'
export function CalculatedDimension({ label, value }: { label: 'W' | 'H'; value: number | undefined }) {
  const { tr } = usePropertyText()
  return <label className="number-field calculated-dimension"><span>{label}</span>
    <input type="text" role="spinbutton" aria-label={label} disabled
      value={value === undefined ? '' : Number(value.toFixed(2))} placeholder={tr('混合')} />
  </label>
}

export function NumberField({ label, value, onChange, resolveInput, min = -1e6, max = 1e6, clampMinimum = false, step = 1, unit = propertyUnit(label), unitDescription, diagnosticFamily, historyLabel = label, formatValue, caption, sliderLabel }: {
  label: string
  value: number
  onChange: (v: number) => void
  resolveInput?: (text: string, original: number) => { value: number; commit?: (value: number) => void } | undefined
  min?: number
  max?: number
  clampMinimum?: boolean
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
  sliderLabel?: string
}) {
  const { locale, tr } = usePropertyText()
  const editor = useContext(PendingEditContext)
  const family = diagnosticFamily ?? numericInputFamily(label)
  const diagnostic = useMemo(() => createInputDiagnostics(editor, family), [editor, family])
  useEffect(() => () => diagnostic.dispose(), [diagnostic])
  const input = useRef<HTMLInputElement>(null), dirty = useRef(false), composing = useRef(false)
  const validationMessage = useRef('')
  const setValidity = (message: string) => {
    validationMessage.current = message
    input.current?.setCustomValidity(message ? tr(message) : '')
  }
  useEffect(() => {
    if (validationMessage.current) input.current?.setCustomValidity(tr(validationMessage.current))
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
    let resolved: ReturnType<NonNullable<typeof resolveInput>>, reason = ''
    try {
      resolved = resolveInput?.(draft.current, original.current)
      v = resolved?.value ?? propertyExpression(draft.current, original.current, unit)
    } catch (error) {
      v = NaN
      if (resolveInput && error instanceof Error) reason = error.message
    }
    const clamped = clampMinimum && v < min
    if (clamped) v = min
    const stale = editor && (!ownsDraft() || value !== original.current)
    if (!draft.current.trim() || !Number.isFinite(v) || v < min || v > max || stale) {
      diagnostic.valid(false)
      setValidity(!stale && reason ? reason : '请输入有效数值；若属性已变化，请按 Esc 取消后重试')
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
      try { (resolved?.commit ?? onChange)(v) } finally { committingValue.current = null }
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
    if (clamped || resolved) {
      draft.current = String(v)
      if (input.current) input.current.value = shown(v)
    }
    setValidity('')
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
  const shownLabel = tr(label)
  const shownCaption = caption === undefined ? shownLabel : tr(caption)
  const scrubHelp = tr("拖动调整数值；Shift 加速，Option 精细调整")
  const shownUnit = unitDescription ? tr(unitDescription) : undefined
  const field = <label className="number-field">
    <span className="number-scrub" title={`${shownLabel}: ${scrubHelp}`} tabIndex={0} role="button" aria-label={locale === 'en' ? `Adjust ${shownLabel} by dragging` : `拖动调整 ${shownLabel}`} aria-description={shownUnit ? `${scrubHelp}；${shownUnit}` : undefined}
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
    >{shownCaption}{shownUnit && <small title={shownUnit}>＊</small>}</span>
    <input ref={input} aria-label={shownLabel} aria-description={shownUnit} type="text" inputMode={resolveInput ? 'text' : 'decimal'} role="spinbutton" aria-valuenow={value} aria-valuemin={min} aria-valuemax={max} title={shownUnit ? `${value}；${shownUnit}` : String(value)} defaultValue={shown(value)}
      onFocus={(e) => { diagnostic.event(InputPhase.focus); if (!dirty.current) e.currentTarget.select() }}
      onChange={(e) => { startDraft(); draftRevision.current++; diagnostic.start(); draft.current = e.currentTarget.value; dirty.current = true; setValidity(''); changed() }}
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
            const fineStep = e.altKey && (interfacePreference.getSnapshot().uiMode !== 'figma' || shortcutPlatform() !== 'mac')
            const next = Math.min(max, Math.max(min, propertyExpression(draft.current, original.current, unit) + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : fineStep ? .1 : 1)))
            draft.current = shown(next); dirty.current = true; e.currentTarget.value = draft.current; changed()
          } catch { setValidity('请先修正数值表达式') }
        }
        if (e.key === 'Escape') {
          e.preventDefault(); diagnostic.cancel(); original.current = value; draft.current = String(value); dirty.current = false
          e.currentTarget.value = String(value); setValidity(''); changed()
        }
        if (e.key === 'Enter' && finish()) e.currentTarget.blur()
      }}
    />
    {unit === 'percent' && <span className="number-unit" aria-hidden="true">%</span>}
  </label>
  if (!sliderLabel) return field
  return <div className="number-field-with-slider">
    <input type="range" aria-label={tr(sliderLabel)} min={min} max={max} step={step} value={value}
      onPointerDown={event => {
        if (event.button !== 0 || !event.isPrimary || editor?.interactionActive || editor?.state.busy || !finish()) { event.preventDefault(); return }
        event.stopPropagation()
        scrub.current = { pointer: event.pointerId, x: event.clientX, base: value, session: editor?.sessionGeneration }
        editor?.begin(`调整 ${historyLabel}`)
        event.currentTarget.setPointerCapture?.(event.pointerId)
      }}
      onChange={event => {
        if (editor?.interactionActive && scrub.current?.session !== editor.sessionGeneration) return
        const next = Number(event.target.value)
        if (!dirty.current && Number.isFinite(next)) onChange(next)
      }}
      onPointerUp={event => { if (scrub.current?.pointer === event.pointerId) stopScrub(false) }}
      onPointerCancel={event => { if (scrub.current?.pointer === event.pointerId) stopScrub(true) }}
      onLostPointerCapture={event => { if (scrub.current?.pointer === event.pointerId) stopScrub(true) }}
      onKeyDown={event => {
        if (event.key === 'Escape' && scrub.current) { event.preventDefault(); event.stopPropagation(); stopScrub(true) }
      }}
    />
    {field}
  </div>
}
