import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { nudgePreference, validNudgeSettings } from './nudge-preference'

export function NudgeSettings() {
  const preference = useSyncExternalStore(nudgePreference.subscribe, nudgePreference.getSnapshot)
  const [draft, setDraft] = useState({ small: String(preference.small), big: String(preference.big) })
  const [error, setError] = useState(''), composing = useRef(false), id = useId()
  useEffect(() => { setDraft({ small: String(preference.small), big: String(preference.big) }); setError('') }, [preference])
  const commit = () => {
    if (composing.current) return
    const value = { small: Number(draft.small), big: Number(draft.big) }
    if (!validNudgeSettings(value)) { setError('请输入 0.01 至 1,000,000 的数值，大步长不能小于小步长。'); return }
    setError(''); nudgePreference.set(value)
  }
  return <div className="nudge-settings">
    <h3>键盘微移</h3>
    <p className="settings-help" id={`${id}-help`}>方向键使用小步长，Shift＋方向键使用大步长。位置、矢量节点与 Sketch-like 尺寸快捷键共用设置；相机平移不受影响。长按为一次撤销，松键或移开焦点完成，Esc 取消。</p>
    {(['small', 'big'] as const).map(key => <label key={key}>{key === 'small' ? '小步长' : '大步长'}
      <input type="number" min="0.01" max="1000000" step="any" value={draft[key]} aria-invalid={!!error} aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`}
        onInput={event => { const text = event.currentTarget.value; setDraft(value => ({ ...value, [key]: text })) }}
        onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
        onBlur={commit} onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composing.current) return
          if (event.key === 'Enter') { event.preventDefault(); if (!event.repeat) commit() }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDraft({ small: String(preference.small), big: String(preference.big) }); setError('') }
        }} />
    </label>)}
    {error && <p id={`${id}-error`} role="alert">{error}</p>}
  </div>
}
