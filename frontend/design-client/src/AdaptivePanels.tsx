import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { interfacePreference, interfaceText, panelWidth, useInterfacePreferences } from './interface-preference'

/** Document-independent shell preferences: never change editor history or input drafts. */
export function useAdaptivePanels() {
  const preferences = useInterfacePreferences()
  const [narrow, setNarrow] = useState(() => window.innerWidth <= 900)
  useEffect(() => { const resize = () => setNarrow(window.innerWidth <= 900); window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize) }, [])
  useEffect(() => {
    const root = document.documentElement, previous = root.getAttribute('data-reduced-motion')
    root.setAttribute('data-reduced-motion', String(preferences.reducedMotion))
    return () => { if (previous === null) root.removeAttribute('data-reduced-motion'); else root.setAttribute('data-reduced-motion', previous) }
  }, [preferences.reducedMotion])
  // Compact screens start with panels closed; opening one never hides the other's pending fields.
  const [compactLeft, setCompactLeft] = useState(false), [compactRight, setCompactRight] = useState(false)
  const leftOpen = narrow ? compactLeft : preferences.leftOpen, rightOpen = narrow ? compactRight : preferences.rightOpen
  const setter = (side: 'left' | 'right', value: boolean | ((current: boolean) => boolean)) => {
    const current = side === 'left' ? leftOpen : rightOpen, next = typeof value === 'function' ? value(current) : value
    if (narrow) (side === 'left' ? setCompactLeft : setCompactRight)(next)
    else interfacePreference.set(side === 'left' ? { leftOpen: next } : { rightOpen: next })
  }
  return { preferences, leftOpen, rightOpen, setLeftOpen: (value: boolean | ((current: boolean) => boolean)) => setter('left', value), setRightOpen: (value: boolean | ((current: boolean) => boolean)) => setter('right', value),
    style: { '--workspace-layers-width': `min(${preferences.leftWidth}px, var(--workspace-panel-cap, max(260px, 26vw)))`, '--workspace-inspector-width': `min(${preferences.rightWidth}px, var(--workspace-panel-cap, max(260px, 26vw)))` } as CSSProperties }
}
export function PanelResizeHandle({ side, blocked = false, canResize = () => true }: { side: 'left' | 'right'; blocked?: boolean; canResize?: () => boolean }) {
  const preferences = useInterfacePreferences(), text = interfaceText[preferences.locale], width = side === 'left' ? preferences.leftWidth : preferences.rightWidth
  const drag = useRef<{ id: number; x: number; width: number; next: number } | null>(null)
  const [preview, setPreview] = useState<number | null>(null)
  const handle = useRef<HTMLDivElement>(null)
  useEffect(() => { const shell = handle.current?.closest<HTMLElement>('.editor-shell'); return () => { if (drag.current) shell?.style.setProperty(side === 'left' ? '--workspace-layers-width' : '--workspace-inspector-width', `min(${drag.current.width}px, var(--workspace-panel-cap, max(260px, 26vw)))`); drag.current = null } }, [side])
  const commit = (value: number) => interfacePreference.set(side === 'left' ? { leftWidth: value } : { rightWidth: value })
  return <div ref={handle} className={`panel-resize-handle panel-resize-${side}`} role="separator" tabIndex={blocked ? -1 : 0} aria-disabled={blocked || undefined}
    aria-label={`${text.resize}: ${text[side]}`} aria-orientation="vertical" aria-valuemin={side === 'left' ? 208 : 260} aria-valuemax={480} aria-valuenow={preview ?? width}
    onPointerDown={event => { if (blocked || !canResize() || event.button !== 0) return; event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture?.(event.pointerId); drag.current = { id: event.pointerId, x: event.clientX, width, next: width } }}
    onPointerMove={event => { const start = drag.current; if (!start || start.id !== event.pointerId) return; start.next = panelWidth(start.width + (event.clientX - start.x) * (side === 'left' ? 1 : -1), side); setPreview(start.next); const shell = event.currentTarget.closest<HTMLElement>('.editor-shell'); shell?.style.setProperty(side === 'left' ? '--workspace-layers-width' : '--workspace-inspector-width', `min(${start.next}px, var(--workspace-panel-cap, max(260px, 26vw)))`) }}
    onPointerUp={event => { const start = drag.current; if (!start || start.id !== event.pointerId) return; drag.current = null; setPreview(null); commit(start.next); event.currentTarget.releasePointerCapture?.(event.pointerId) }}
    onLostPointerCapture={event => { if (!drag.current) return; drag.current = null; setPreview(null); event.currentTarget.closest<HTMLElement>('.editor-shell')?.style.setProperty(side === 'left' ? '--workspace-layers-width' : '--workspace-inspector-width', `min(${width}px, var(--workspace-panel-cap, max(260px, 26vw)))`) }}
    onPointerCancel={event => { drag.current = null; setPreview(null); event.currentTarget.closest<HTMLElement>('.editor-shell')?.style.setProperty(side === 'left' ? '--workspace-layers-width' : '--workspace-inspector-width', `min(${width}px, var(--workspace-panel-cap, max(260px, 26vw)))`) }}
    onKeyDown={event => { if (blocked || !canResize() || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); event.stopPropagation(); commit(event.key === 'Home' ? (side === 'left' ? 208 : 260) : event.key === 'End' ? 480 : panelWidth(width + (event.key === 'ArrowRight' ? 1 : -1) * (side === 'left' ? 1 : -1) * (event.shiftKey ? 32 : 8), side)) }} />
}
export function InterfaceSettings() {
  const preferences = useInterfacePreferences(), text = interfaceText[preferences.locale]
  const persisted = useSyncExternalStore(interfacePreference.subscribe, interfacePreference.getPersistenceSnapshot)
  return <div className="interface-settings"><h3>{text.interface}</h3>
    <label>{text.language}<select value={preferences.locale} onChange={event => interfacePreference.set({ locale: event.target.value === 'en' ? 'en' : 'zh-CN' })}><option value="zh-CN">简体中文</option><option value="en">English</option></select></label>
    <p className="settings-help">{text.languageHelp}</p>
    <label className="settings-toggle"><input type="checkbox" checked={preferences.reducedMotion} onChange={event => interfacePreference.set({ reducedMotion: event.target.checked })} /><span>{text.motion}</span></label>
    <p className="settings-help">{text.motionHelp}</p>
    <label className="settings-toggle"><input type="checkbox" checked={preferences.rememberViewport} onChange={event => interfacePreference.set({ rememberViewport: event.target.checked })} /><span>{text.rememberViewport}</span></label>
    <p className="settings-help">{text.rememberViewportHelp}</p>
    <button type="button" onClick={() => interfacePreference.set({ leftWidth: 248, rightWidth: 280, leftOpen: true, rightOpen: true })}>{text.reset}</button>
    {!persisted && <p role="status">{text.temporary}</p>}
  </div>
}
