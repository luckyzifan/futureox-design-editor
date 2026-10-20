import { createInputDiagnostics, InputFamily, InputPhase } from './input-diagnostics'
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type InputHTMLAttributes } from 'react'
import type { Editor } from './engine'
import { PendingEditContext } from './pending-edit-context'
import { pendingEditsChanged, registerPendingEdit } from './pending-edits'

/** Deferred document field: preserve invalid/conflicting drafts and veto lifecycle boundaries. */
export function DraftInput({ value, onCommit, validate = () => true, normalize = (value) => value,
  editor: explicitEditor, diagnosticFamily = InputFamily.generic, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'defaultValue' | 'onChange'> & {
  value: string
  onCommit: (value: string) => void
  validate?: (value: string) => boolean
  normalize?: (value: string) => string
  editor?: Editor
  diagnosticFamily?: number
}) {
  const inherited = useContext(PendingEditContext), editor = explicitEditor || inherited
  const diagnostic = useMemo(() => createInputDiagnostics(editor, diagnosticFamily), [editor, diagnosticFamily])
  useEffect(() => () => diagnostic.dispose(), [diagnostic])
  const [draft, setDraft] = useState(value)
  const input = useRef<HTMLInputElement>(null), latest = useRef(value), original = useRef(value)
  const composing = useRef(false), session = useRef(editor?.sessionGeneration)
  const dirty = useCallback(() => composing.current || latest.current !== original.current, [])
  const changed = () => { if (editor) pendingEditsChanged(editor) }
  const finish = () => {
    if (!dirty()) return true
    if (composing.current) return false
    diagnostic.start()
    const next = normalize(latest.current)
    if (!validate(next) || value !== original.current || (editor && session.current !== editor.sessionGeneration)) {
      diagnostic.valid(false)
      input.current?.setCustomValidity('输入无效或属性已变化；输入已保留，请修正或按 Esc 取消')
      input.current?.reportValidity()
      return false
    }
    diagnostic.valid(true)
    const changedValue = next !== original.current
    if (changedValue) {
      const before = editor?.state.doc
      onCommit(next)
      if (editor && before === editor.state.doc) { diagnostic.finish(false, false); return false }
    }
    diagnostic.finish(changedValue, !!editor || !changedValue)
    original.current = next; latest.current = next; setDraft(next)
    input.current?.setCustomValidity(''); changed()
    return true
  }
  const commit = useRef(finish); commit.current = finish
  useEffect(() => editor ? registerPendingEdit(editor, { dirty, commit: () => commit.current() }) : undefined, [editor, dirty])
  useEffect(() => {
    if (!dirty()) { original.current = value; latest.current = value; setDraft(value) }
  }, [value, dirty])
  return <input {...props} ref={input} value={draft}
    aria-invalid={!validate(normalize(draft))}
    onFocus={(event) => { diagnostic.event(InputPhase.focus); props.onFocus?.(event) }}
    onChange={(event) => { diagnostic.start(); latest.current = event.currentTarget.value; setDraft(latest.current); event.currentTarget.setCustomValidity(''); changed() }}
    onCompositionStart={() => { diagnostic.start(); diagnostic.event(InputPhase.compositionStart); composing.current = true; changed() }}
    onCompositionEnd={(event) => { diagnostic.event(InputPhase.compositionEnd); composing.current = false; latest.current = event.currentTarget.value; setDraft(latest.current); changed() }}
    onBlur={() => { diagnostic.event(InputPhase.blur); finish() }}
    onKeyDown={(event) => {
      if (composing.current || event.nativeEvent.isComposing) return
      if (event.key === 'Enter' && finish()) event.currentTarget.blur()
      if (event.key === 'Escape') {
        event.preventDefault(); diagnostic.cancel(); original.current = value; latest.current = value; setDraft(value)
        event.currentTarget.setCustomValidity(''); changed()
      }
    }}
  />
}
