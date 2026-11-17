import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Editor } from './engine'
import { useInterfacePreferences } from './interface-preference'
import { modalKeyDown, useModalOwnership } from './modal-keyboard'
import { commitPendingEdits } from './pending-edits'
import { interactivePath } from './selection-hierarchy'
import { applySketchLayerStyle } from './sketch-layer-style'
import './frame-presets.css'

export type SketchReplacementTarget = {
  id: string
  kind: 'symbol' | 'text' | 'paint'
  source: string
  page: string
  generation: number
}

export function sketchReplacementTarget(editor: Editor): SketchReplacementTarget | undefined {
  const { doc, page, selection } = editor.state
  if (selection.length !== 1) return
  const id = selection[0], node = doc.nodes[id]
  if (!node || !interactivePath(doc, page, id, false, editor.parentMap()).length) return
  const selectionOwner = { id, page, generation: editor.sessionGeneration }
  if (node.instance) return { ...selectionOwner, kind: 'symbol', source: node.instance.componentId }
  if (node.instanceOrigin || node.kind === 'frame') return
  const text = node.styleRefs?.textStyle
  if (node.kind === 'text' && text && doc.designSystem?.styles[text]?.kind === 'text')
    return { ...selectionOwner, kind: 'text', source: text }
  const paint = node.styleRefs?.fills
  if (paint && doc.designSystem?.styles[paint]?.kind === 'paint')
    return { ...selectionOwner, kind: 'paint', source: paint }
}

const headings = {
  symbol: ['替换组件', 'Replace Symbol'],
  text: ['替换文字样式', 'Replace Text Style'],
  paint: ['替换图层样式', 'Replace Layer Style'],
} as const

export function SketchReplacementDialog({ editor, target, onClose }: {
  editor: Editor
  target: SketchReplacementTarget
  onClose: () => void
}) {
  const { locale } = useInterfacePreferences()
  const en = locale === 'en'
  const title = headings[target.kind][en ? 1 : 0]
  const dialog = useRef<HTMLElement>(null), search = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState(''), [chosen, setChosen] = useState(''), [error, setError] = useState('')
  useModalOwnership(dialog, search)

  const { doc } = editor.state
  const candidates = target.kind === 'symbol'
    ? Object.values(doc.nodes).filter(node => node.component).map(({ id, name }) => ({ id, name }))
    : Object.entries(doc.designSystem?.styles || {}).filter(([, style]) => style.kind === target.kind)
      .map(([id, { name }]) => ({ id, name }))
  const matching = candidates.filter(({ id, name }) => id !== target.source && name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const choice = matching.find(({ id }) => id === chosen) ?? (matching.length === 1 ? matching[0] : undefined)
  const ownsTarget = () => {
    if (editor.state.busy || editor.interactionActive) return false
    const current = sketchReplacementTarget(editor)
    return current?.generation === target.generation && current.page === target.page &&
      current.id === target.id && current.kind === target.kind && current.source === target.source
  }
  const replace = (id: string) => {
    if (!ownsTarget() || !commitPendingEdits(editor) || !ownsTarget()) {
      setError(en ? 'The selection changed. Reopen the replacement list.' : '所选图层已变化，请重新打开替换列表。')
      return
    }
    const result = target.kind === 'symbol'
      ? editor.swapInstance(target.id, id)
      : editor.change('应用共享样式', draft => {
          const style = draft.designSystem?.styles[id], node = draft.nodes[target.id]
          if (!style || style.kind !== target.kind) throw new Error(en ? 'The style is unavailable.' : '此样式已不可用。')
          if (style.kind === 'paint') applySketchLayerStyle(node, id, style)
          else node.styleRefs = { ...node.styleRefs, textStyle: id }
        })
    if (result.status === 'committed' || result.status === 'unchanged') onClose()
    else setError(result.status === 'rejected' ? result.message : en ? 'Finish the current edit and try again.' : '请先完成当前编辑。')
  }

  return createPortal(
    <div className="frame-preset-backdrop" onPointerDown={event => {
      event.stopPropagation()
      if (event.target === event.currentTarget) onClose()
    }}>
      <section ref={dialog} tabIndex={-1} className="frame-preset-panel sketch-replacement-panel"
        role="dialog" aria-modal="true" aria-label={title} onKeyDown={event => modalKeyDown(event, onClose)}>
        <header><strong>{title}</strong><button type="button" onClick={onClose}>{en ? 'Close' : '关闭'}</button></header>
        <form onSubmit={event => { event.preventDefault(); if (choice) replace(choice.id) }}>
          <input ref={search} type="search" aria-label={en ? 'Search replacements' : '搜索替换项'}
            value={query} onChange={event => { setQuery(event.target.value); setChosen(''); setError('') }} />
          {matching.length ? <select size={Math.min(8, Math.max(2, matching.length))} aria-label={title} value={choice?.id || ''}
            onChange={event => { setChosen(event.target.value); setError('') }}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && choice) {
                event.preventDefault()
                if (!event.repeat) replace(choice.id)
              }
            }}>
            {matching.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
          </select> : <p role="status">{en ? 'No replacements found' : '没有匹配的替换项'}</p>}
          <button type="submit" disabled={!choice}>{en ? 'Replace' : '替换'}</button>
        </form>
        {error && <p role="alert">{error}</p>}
      </section>
    </div>,
    document.body,
  )
}
