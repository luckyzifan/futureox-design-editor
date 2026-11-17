import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Editor } from './engine'
import { useInterfacePreferences } from './interface-preference'
import { modalKeyDown, useModalOwnership } from './modal-keyboard'
import { commitPendingEdits } from './pending-edits'
import { createSketchSymbol, sketchSymbolSelection } from './sketch-symbol'
import './frame-presets.css'

export type SketchSymbolTarget = { ids: string[]; documentId: string; page: string; generation: number }

export function SketchSymbolDialog({ editor, target, onClose }: {
  editor: Editor; target: SketchSymbolTarget; onClose: () => void
}) {
  const { locale } = useInterfacePreferences()
  const en = locale === 'en'
  const title = en ? 'Create Symbol' : '创建控件'
  const dialog = useRef<HTMLElement>(null), input = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(target.ids.length === 1 ? editor.authoredDocument.nodes[target.ids[0]].name : (en ? 'Symbol' : '控件'))
  const [send, setSend] = useState(false), [error, setError] = useState('')
  useModalOwnership(dialog, input)
  const ownsSelection = () => {
    const ids = sketchSymbolSelection(editor)
    return !editor.state.busy && !editor.interactionActive && editor.state.doc.id === target.documentId &&
      editor.state.page === target.page && editor.sessionGeneration === target.generation &&
      ids.length === target.ids.length && ids.every(id => target.ids.includes(id))
  }
  return createPortal(
    <div className="frame-preset-backdrop" onPointerDown={event => {
      event.stopPropagation()
      if (event.target === event.currentTarget) onClose()
    }}>
      <section ref={dialog} tabIndex={-1} className="frame-preset-panel sketch-replacement-panel"
        role="dialog" aria-modal="true" aria-label={title} onKeyDown={event => modalKeyDown(event, onClose)}>
        <header><strong>{title}</strong><button type="button" onClick={onClose}>{en ? 'Cancel' : '取消'}</button></header>
        <form onSubmit={event => {
          event.preventDefault()
          const label = name.trim()
          if (!label) return
          if (!ownsSelection() || !commitPendingEdits(editor) || !ownsSelection()) {
            setError(en ? 'The selection changed. Reopen Create Symbol.' : '选区已变化，请重新打开创建控件。')
            return
          }
          let instanceId = ''
          const result = editor.change('创建控件', doc => {
            instanceId = createSketchSymbol(doc, target.ids, target.page, label, send)
          })
          if (result.status !== 'committed') {
            setError(result.status === 'rejected' ? result.message : (en ? 'Complete the current edit first.' : '请先完成当前编辑。'))
            return
          }
          editor.select([instanceId])
          onClose()
        }}>
          <input ref={input} aria-label={en ? 'Symbol name' : '控件名称'} value={name}
            onFocus={event => event.currentTarget.select()} onChange={event => { setName(event.target.value); setError('') }} />
          <label><input type="checkbox" checked={send} onChange={event => setSend(event.target.checked)} />
            {en ? 'Send source to Symbols page' : '将源移到 Symbols 页'}
          </label>
          <button type="submit" disabled={!name.trim()}>{en ? 'Create' : '创建'}</button>
        </form>
        {error && <p role="alert">{error}</p>}
      </section>
    </div>,
    document.body,
  )
}
