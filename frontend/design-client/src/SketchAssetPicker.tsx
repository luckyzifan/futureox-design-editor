import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useInterfacePreferences } from './interface-preference'
import { modalKeyDown, useModalOwnership } from './modal-keyboard'
import './frame-presets.css'

export function SketchAssetPicker({ title, searchLabel, emptyLabel, confirmLabel, candidates, onChoose, onClose }: {
  title: string
  searchLabel: string
  emptyLabel: string
  confirmLabel: string
  candidates: readonly { id: string; name: string }[]
  onChoose: (id: string) => string | void
  onClose: () => void
}) {
  const { locale } = useInterfacePreferences()
  const dialog = useRef<HTMLElement>(null), search = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState(''), [chosen, setChosen] = useState(''), [error, setError] = useState('')
  useModalOwnership(dialog, search)
  const matching = candidates.filter(({ name }) => name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const choice = matching.find(({ id }) => id === chosen) ?? (matching.length === 1 ? matching[0] : undefined)
  const choose = () => {
    if (!choice) return
    const failure = onChoose(choice.id)
    if (failure) setError(failure)
    else onClose()
  }
  return createPortal(
    <div className="frame-preset-backdrop" onPointerDown={event => {
      event.stopPropagation()
      if (event.target === event.currentTarget) onClose()
    }}>
      <section ref={dialog} tabIndex={-1} className="frame-preset-panel sketch-replacement-panel"
        role="dialog" aria-modal="true" aria-label={title} onKeyDown={event => modalKeyDown(event, onClose)}>
        <header><strong>{title}</strong><button type="button" onClick={onClose}>{locale === 'en' ? 'Close' : '关闭'}</button></header>
        <form onSubmit={event => { event.preventDefault(); choose() }}>
          <input ref={search} type="search" aria-label={searchLabel}
            value={query} onChange={event => { setQuery(event.target.value); setChosen(''); setError('') }} />
          {matching.length ? <select size={Math.min(8, Math.max(2, matching.length))} aria-label={title} value={choice?.id || ''}
            onChange={event => { setChosen(event.target.value); setError('') }}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && choice) {
                event.preventDefault()
                if (!event.repeat) choose()
              }
            }}>
            {matching.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
          </select> : <p role="status">{emptyLabel}</p>}
          <button type="submit" disabled={!choice}>{confirmLabel}</button>
        </form>
        {error && <p role="alert">{error}</p>}
      </section>
    </div>,
    document.body,
  )
}
