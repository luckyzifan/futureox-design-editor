import { usePropertyText } from './property-interface-messages'
import { SolidFillColorInput } from './ColorPickerPopover'
import type { SolidFillTarget } from './property-preview'
import { createInputDiagnostics, InputFamily, InputPhase } from './input-diagnostics'
import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Pipette } from 'lucide-react'
import { DraftInput } from './DraftInput'
import { displayColorHex, validColor } from './color'
import { PendingEditContext } from './pending-edit-context'
import { commitPendingEdits } from './pending-edits'
import { requestCanvasColor } from './canvas-color-picker'
type ColorInputProps = { value: string; onChange: (value: string) => void; label: string; target?: SolidFillTarget; editableHex?: boolean }
export function ColorInput(props: ColorInputProps) {
  return props.target ? <SolidFillColorInput target={props.target} value={props.value} label={props.label} /> : <LegacyColorInput {...props} />
}
const hexColor = /^#[0-9a-f]{6}$/i
function normalizeHexEntry(input: string) {
  const value = input.trim()
  const hex = value.startsWith('#') ? value : `#${value}`
  return hexColor.test(hex) ? hex.toUpperCase() : value
}
/** Legacy callback controls have no preview authority. Stroke/effect/mixed
 * adapters remain unchanged until their separately reviewed target slice. */
function LegacyColorInput({
  value,
  onChange,
  label,
  editableHex,
}: {
  value: string
  onChange: (value: string) => void
  label: string
  editableHex?: boolean
}) {
  const { locale, tr } = usePropertyText()
  const editor = useContext(PendingEditContext),
    current = useRef({ value, onChange }),
    controller = useRef<AbortController | null>(null),
    mounted = useRef(true),
    [error, setError] = useState('')
  const diagnostic = useMemo(() => createInputDiagnostics(editor, InputFamily.color), [editor])
  useEffect(() => () => diagnostic.dispose(), [diagnostic])
  const applyColor = (next: string) => {
    diagnostic.start()
    const before = editor?.state.doc
    current.current.onChange(next)
    diagnostic.finish(!!editor && editor.state.doc !== before, !!editor && (editor.state.doc !== before || next === current.current.value))
  }
  current.current = { value, onChange }
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      controller.current?.abort()
    }
  }, [])
  async function sample() {
    if (editor && (editor.interactionActive || !commitPendingEdits(editor))) return
    const EyeDropper = (
      globalThis as unknown as {
        EyeDropper?: new () => { open(options: { signal: AbortSignal }): Promise<{ sRGBHex: string }> }
      }
    ).EyeDropper
    if (!editor && !EyeDropper) {
      setError('此环境不支持屏幕吸管')
      return
    }
    controller.current?.abort()
    const owner = new AbortController()
    controller.current = owner
    const version = editor?.state.version,
      session = editor?.sessionGeneration,
      page = editor?.state.page,
      selection = editor?.state.selection.join(','),
      original = current.current.value
    diagnostic.start()
    try {
      setError('')
      const result = editor ? await requestCanvasColor(editor,owner.signal) : await new EyeDropper!().open({ signal: owner.signal })
      if (!mounted.current || owner.signal.aborted) { diagnostic.cancel(); return }
      if (
        editor
          ? editor.state.version !== version ||
            editor.state.page !== page ||
            editor.sessionGeneration !== session ||
            editor.state.selection.join(',') !== selection
          : current.current.value !== original
      )
        throw new Error('取样期间属性已变化，请重试')
      if (!/^#[\da-f]{6}$/i.test(result.sRGBHex)) throw new Error('取样颜色无效')
      applyColor(result.sRGBHex)
    } catch (e) {
      if (owner.signal.aborted || (e as Error).name === 'AbortError') diagnostic.cancel(); else { diagnostic.valid(false); diagnostic.finish(false, false) }
      if (!owner.signal.aborted && (e as Error).name !== 'AbortError' && mounted.current) setError(String(e))
    } finally {
      if (controller.current === owner) controller.current = null
    }
  }
  const shown = displayColorHex(value)
  return (
    <span
      className="color-input"
      onKeyDown={(e) => {
        if (
          e.ctrlKey &&
          !e.metaKey &&
          !e.altKey &&
          e.key.toLowerCase() === 'c' &&
          /Mac/.test(navigator.platform)
        ) {
          e.preventDefault()
          e.stopPropagation()
          void sample()
        }
      }}
    >
      {shown ? (
        <>
          <input aria-label={editableHex ? (locale === 'en' ? `${label} picker` : `${label} 色板`) : label} type="color" value={shown.toLowerCase()} onFocus={() => diagnostic.event(InputPhase.focus)} onBlur={() => diagnostic.event(InputPhase.blur)} onChange={(e) => applyColor(e.target.value)} />
          {editableHex ? (
            <DraftInput type="text" aria-label={label} className="color-readout" size={8} spellCheck={false}
              value={shown} diagnosticFamily={InputFamily.color} normalize={normalizeHexEntry}
              validate={next => hexColor.test(next)} onCommit={next => onChange(next.toLowerCase())} />
          ) : <span className="color-readout">{shown}</span>}
        </>
      ) : (
        <DraftInput diagnosticFamily={InputFamily.color}
          aria-label={label}
          value={value}
          onCommit={onChange}
          validate={(color) => validColor(color, true)}
        />
      )}
      <button type="button" aria-label={locale === 'en' ? `Sample ${label}` : `吸取${label}`} title={tr("从画布取样")} onClick={() => void sample()}>
        <Pipette size={13} />
      </button>
      {error && <span role="alert">{error}</span>}
    </span>
  )
}
