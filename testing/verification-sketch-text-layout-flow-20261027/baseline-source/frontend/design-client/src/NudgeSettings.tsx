import { useInterfaceText } from './interface-preference'
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { nudgePreference, validNudgeSettings } from './nudge-preference'

export function NudgeSettings() {
  const text = useInterfaceText()
  const preference = useSyncExternalStore(nudgePreference.subscribe, nudgePreference.getSnapshot)
  const [draft, setDraft] = useState({ small: String(preference.small), big: String(preference.big) })
  const [error, setError] = useState(false), composing = useRef(false), id = useId()
  useEffect(() => { setDraft({ small: String(preference.small), big: String(preference.big) }); setError(false) }, [preference])
  const commit = () => {
    if (composing.current) return
    const value = { small: Number(draft.small), big: Number(draft.big) }
    if (!validNudgeSettings(value)) { setError(true); return }
    setError(false); nudgePreference.set(value)
  }
  return <div className="nudge-settings">
    <h3>{text.nudge}</h3>
    <p className="settings-help" id={`${id}-help`}>{text.nudgeHelp}</p>
    {(['small', 'big'] as const).map(key => <label key={key}>{key === 'small' ? text.smallStep : text.bigStep}
      <input type="number" min="0.01" max="1000000" step="any" value={draft[key]} aria-invalid={!!error} aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`}
        onInput={event => { const text = event.currentTarget.value; setDraft(value => ({ ...value, [key]: text })) }}
        onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
        onBlur={commit} onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composing.current) return
          if (event.key === 'Enter') { event.preventDefault(); if (!event.repeat) commit() }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDraft({ small: String(preference.small), big: String(preference.big) }); setError(false) }
        }} />
    </label>)}
    {error && <p id={`${id}-error`} role="alert">{text.nudgeError}</p>}
  </div>
}
