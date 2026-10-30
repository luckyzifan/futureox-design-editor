import { useInterfaceText } from './interface-preference'
import type { InterfaceMessageKey } from './interface-messages'
import { canvasActions, CanvasAction, ActionSource, ActionOutcome } from './canvas-action-diagnostics'
import { desktopPet } from './desktop-pet'
import { InterfaceSettings } from './AdaptivePanels'
import { interfacePreference } from './interface-preference'
import { LocalDiagnosticsPanel } from './LocalDiagnosticsPanel'
import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Editor } from './engine'
import { NudgeSettings } from './NudgeSettings'
import { nudgePreference } from './nudge-preference'
import { KeyboardProfileSettings } from './KeyboardProfileSettings'
import { shortcutPreference } from './shortcut-preference'
import { settingsPreference, useSettingsPersistence, type CanvasSetting } from './settings-preference'
import { pageMemoryPreference, useRenderMemoryTier } from './page-memory-preference'
import { validRenderMemoryTier } from './kernel/page-memory-policy'
import './settings-dialog.css'

type SettingsSection = 'input' | 'canvas' | 'saving' | 'companion' | 'diagnostics'
const sections: { id: SettingsSection; label: InterfaceMessageKey }[] = [
  { id: 'input', label: 'inputTab' }, { id: 'canvas', label: 'canvasTab' }, { id: 'saving', label: 'savingTab' }, { id: 'companion', label: 'companionTab' }, { id: 'diagnostics', label: 'diagnosticsTab' },
]
const canvasControls: { key: CanvasSetting; label: InterfaceMessageKey; detail: InterfaceMessageKey }[] = [
  { key: 'snap', label: 'snap', detail: 'snapHelp' },
  { key: 'snapPixels', label: 'snapPixels', detail: 'snapPixelsHelp' },
  { key: 'pixelGrid', label: 'pixelGrid', detail: 'pixelGridHelp' },
  { key: 'rulers', label: 'rulers', detail: 'rulersHelp' },
  { key: 'checkerboard', label: 'checkerboard', detail: 'checkerboardHelp' },
  { key: 'grid', label: 'grid', detail: 'gridHelp' },
]

/** The parent binds bindEditorSettings(editor) for the complete Editor lifetime. */
export function SettingsDialog({ editor, onClose, desktop = false, returnFocus, workspaceControls, busy = false }: {
  editor: Editor
  onClose: () => void
  desktop?: boolean
  returnFocus?: HTMLElement | null
  workspaceControls?: ReactNode
  busy?: boolean
}) {
  const text = useInterfaceText()
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot)
  const persistence = useSettingsPersistence()
  const memoryTier = useRenderMemoryTier()
  const memoryPersistence = useSyncExternalStore(pageMemoryPreference.subscribe, pageMemoryPreference.getPersistenceSnapshot)
  const petMode = useSyncExternalStore(desktopPet.subscribe, desktopPet.snapshot)
  const nudgePersistence = useSyncExternalStore(nudgePreference.subscribe, nudgePreference.getPersistenceSnapshot)
  const id = useId(), dialog = useRef<HTMLElement>(null), backdrop = useRef<HTMLDivElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null), close = useRef(onClose), closing = useRef(false)
  const restoreTarget = useRef(returnFocus), [section, setSection] = useState<SettingsSection>('input')
  const [message, setMessage] = useState<InterfaceMessageKey | ''>(''), [wheelTemporary, setWheelTemporary] = useState(false)
  const [keyboardReset, setKeyboardReset] = useState(0)
  close.current = onClose
  const dismiss = () => { if (!busy && !closing.current) { closing.current = true; close.current() } }
  const controls = () => [...(dialog.current?.querySelectorAll<HTMLElement>(
    'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]',
  ) || [])].filter(element => element.tabIndex >= 0 && !element.closest('[hidden],[inert]') && element.getAttribute('aria-hidden') !== 'true')

  useLayoutEffect(() => {
    const previous = restoreTarget.current || (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    const bodyOverflow = document.body.style.overflow
    // Inert removes the background from keyboard and assistive-technology navigation.
    // Restore exact prior attributes, including a pre-existing inert owner.
    const background = [...document.body.children].filter(element => element !== backdrop.current)
      .map(element => ({ element, inert: element.getAttribute('inert') }))
    for (const { element } of background) element.setAttribute('inert', '')
    document.body.style.overflow = 'hidden'
    ;(closeButton.current?.disabled ? dialog.current : closeButton.current)?.focus({ preventScroll: true })
    const retainFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.current?.contains(event.target)) (closeButton.current?.disabled ? dialog.current : closeButton.current)?.focus({ preventScroll: true })
    }
    document.addEventListener('focusin', retainFocus)
    return () => {
      document.removeEventListener('focusin', retainFocus)
      for (const { element, inert } of background) {
        if (inert === null) element.removeAttribute('inert'); else element.setAttribute('inert', inert)
      }
      document.body.style.overflow = bodyOverflow
      const target = previous?.isConnected && !previous.closest('[inert]') && previous !== document.body
        ? previous : document.querySelector<HTMLElement>('[data-testid="canvas"]')
      target?.focus({ preventScroll: true })
    }
  }, [])

  // These stores are independent of the six canvas-aid booleans. Observe
  // applied family changes only; never emit chosen values or preference JSON.
  useLayoutEffect(() => {
    const watch = (get: () => unknown, subscribe: (listener: () => void) => () => void, commandCode: number) => {
      let previous = get()
      return subscribe(() => {
        const next = get()
        if (Object.is(previous, next)) return
        previous = next
        canvasActions(editor).event(CanvasAction.settings, ActionSource.properties, ActionOutcome.observed, undefined, { commandCode })
      })
    }
    const stops = [watch(shortcutPreference.getSnapshot, shortcutPreference.subscribe, 340),
      watch(nudgePreference.getSnapshot, nudgePreference.subscribe, 341),
      watch(interfacePreference.getSnapshot, interfacePreference.subscribe, 342),
      watch(desktopPet.snapshot, desktopPet.subscribe, 343)]
    return () => { for (const stop of stops) stop() }
  }, [editor])

  const setWheel = (enabled: boolean) => {
    const previous = editor.state.scrollWheelZoom
    editor.setScrollWheelZoom(enabled)
    canvasActions(editor).event(CanvasAction.settings, ActionSource.properties, previous === editor.state.scrollWheelZoom ? ActionOutcome.unchanged : ActionOutcome.observed, undefined, { commandCode: 344 })
    let persisted = false
    try { persisted = localStorage.getItem('forma-scroll-wheel-zoom') === String(enabled) } catch { /* Denied storage remains session-only. */ }
    setWheelTemporary(!persisted)
    return persisted
  }
  const restoreDefaults = () => {
    canvasActions(editor).event(CanvasAction.settings, ActionSource.properties, ActionOutcome.observed, undefined, { commandCode: 349 })
    const memorySaved = pageMemoryPreference.reset()
    const petSaved = desktopPet.configure('off')
    const interfaceSaved = interfacePreference.reset()
    const canvasSaved = settingsPreference.reset()
    const keyboardSaved = shortcutPreference.set('figma-like')
    const nudgeSaved = nudgePreference.reset()
    const wheelSaved = setWheel(false)
    setKeyboardReset(value => value + 1)
    setMessage(memorySaved && petSaved && interfaceSaved && canvasSaved && keyboardSaved && nudgeSaved && wheelSaved ? 'defaultsRestored' : 'defaultsTemporary')
  }

  return createPortal(<div ref={backdrop} className="settings-backdrop"
    onPointerDown={event => { event.stopPropagation(); if (event.target === event.currentTarget) dismiss() }}
    onPointerUp={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
    <section ref={dialog} className="settings-dialog" role="dialog" aria-modal="true" aria-busy={busy || undefined} aria-labelledby={`${id}-title`} aria-describedby={`${id}-scope`} tabIndex={-1}
      onKeyDown={event => {
        event.stopPropagation()
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
        if (event.key === 'Escape') { event.preventDefault(); if (!event.repeat) dismiss(); return }
        if (event.key !== 'Tab') return
        const enabled = controls(), first = enabled[0], last = enabled.at(-1)
        if (!first) { event.preventDefault(); dialog.current?.focus(); return }
        if (event.shiftKey && (document.activeElement === first || !enabled.includes(document.activeElement as HTMLElement))) {
          event.preventDefault(); last?.focus()
        } else if (!event.shiftKey && (document.activeElement === last || !enabled.includes(document.activeElement as HTMLElement))) {
          event.preventDefault(); first.focus()
        }
      }}>
      <header className="settings-header">
        <div><h2 id={`${id}-title`}>{text.settingsTitle}</h2><p id={`${id}-scope`}>{text.settingsScope}</p></div>
        <button ref={closeButton} type="button" aria-label={text.closeSettings} disabled={busy} onClick={dismiss}>×</button>
      </header>
      <div className="settings-layout">
        <div className="settings-tabs" role="tablist" aria-label={text.settingsCategories}>
          {sections.map(({ id: value, label }, index) => <button key={value} type="button" role="tab" id={`${id}-tab-${value}`}
            aria-controls={`${id}-panel-${value}`} aria-selected={section === value} tabIndex={section === value ? 0 : -1}
            onClick={() => setSection(value)} onKeyDown={event => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
              if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
              event.preventDefault()
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1
                : (index + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + sections.length) % sections.length
              setSection(sections[next].id)
              document.getElementById(`${id}-tab-${sections[next].id}`)?.focus()
            }}>{text[label]}</button>)}
        </div>
        <div className="settings-content">
          <section role="tabpanel" id={`${id}-panel-input`} aria-labelledby={`${id}-tab-input`} hidden={section !== 'input'}>
            <h3>{text.keyboard}</h3>
            <KeyboardProfileSettings key={keyboardReset} />
            <NudgeSettings key={`nudge-${keyboardReset}`} />
            <h3>{text.canvasNavigation}</h3>
            <label className="settings-toggle"><input type="checkbox" checked={state.scrollWheelZoom} aria-describedby={`${id}-wheel-help`}
              onChange={event => { setMessage(''); setWheel(event.target.checked) }} /><span>{text.wheelZoom}</span></label>
            <p className="settings-help" id={`${id}-wheel-help`}>{text.wheelHelp}</p>
          </section>
          <section role="tabpanel" id={`${id}-panel-canvas`} aria-labelledby={`${id}-tab-canvas`} hidden={section !== 'canvas'}>
            <InterfaceSettings />
            <h3>{text.pageRetention}</h3>
            <label htmlFor={`${id}-memory-tier`}>{text.cacheMemory}</label>
            <select id={`${id}-memory-tier`} value={memoryTier} aria-describedby={`${id}-memory-help`}
              onChange={event => { if (validRenderMemoryTier(event.target.value)) {
                const saved = pageMemoryPreference.set(event.target.value)
                setMessage(saved ? 'cacheSaved' : 'cacheTemporary')
              } }}>
              <option value="conservative">{text.cacheConservative}</option>
              <option value="balanced">{text.cacheBalanced}</option>
              <option value="expanded">{text.cacheExpanded}</option>
            </select>
            <p id={`${id}-memory-help`} className="settings-help">{text.cacheHelp}</p>
            {memoryPersistence === 'session-only' && <p role="status">{text.cacheTemporary}</p>}
            <h3>{text.displaySnapping}</h3>
            <p className="settings-help">{text.displaySnappingHelp}</p>
            {canvasControls.map(({ key, label, detail }) => <div className="settings-control" key={key}>
              <label className="settings-toggle"><input type="checkbox" checked={!!state[key]} aria-describedby={`${id}-${key}-help`}
                onChange={event => { setMessage(''); editor.set({ [key]: event.target.checked }) }} /><span>{text[label]}</span></label>
              <p id={`${id}-${key}-help`} className="settings-help">{text[detail]}</p>
            </div>)}
          </section>
          <section role="tabpanel" id={`${id}-panel-saving`} aria-labelledby={`${id}-tab-saving`} hidden={section !== 'saving'}>
            {workspaceControls}
            <h3>{text.savingMode}</h3>
            {desktop ? <p>{text.savingDesktop}</p>
              : <p>{text.savingWeb}</p>}
            <p className="settings-help">{text.savingHelp}</p>
            <h3>{text.preferencesDocuments}</h3>
            <p>{text.preferencesScope}{desktop ? text.preferencesDesktop : text.preferencesWeb}{text.documentsScope}</p>
            <p className="settings-help">{text.resetScope}</p>
          </section>
          <section role="tabpanel" id={`${id}-panel-companion`} aria-labelledby={`${id}-tab-companion`} hidden={section !== 'companion'}>
            <h3>{text.companionTitle}</h3>
            {desktop ? <>
              <p role="status">{text.companionUnavailable}</p>
              <p className="settings-help">{text.companionHelp}</p>
              {petMode !== 'off' && <button type="button" onClick={() => {
                const saved = desktopPet.configure('off'); setMessage(saved ? 'companionDisabled' : 'companionTemporary')
              }}>{text.disableCompanion}</button>}
            </> : <p>{text.companionDesktopOnly}</p>}
          </section>
          <section role="tabpanel" id={`${id}-panel-diagnostics`} aria-labelledby={`${id}-tab-diagnostics`} hidden={section !== 'diagnostics'}>
            {section === 'diagnostics' && <LocalDiagnosticsPanel />}
          </section>
        </div>
      </div>
      <footer className="settings-footer">
        <div className="settings-status" role="status" aria-live="polite">
          {message ? text[message] : ((persistence === 'session-only' || nudgePersistence === 'session-only' || wheelTemporary) ? text.preferencesTemporary : text.preferencesImmediate)}
        </div>
        <div className="settings-actions"><button type="button" className="secondary" disabled={busy} onClick={restoreDefaults}>{text.restoreDefaults}</button><button type="button" className="primary" disabled={busy} onClick={dismiss}>{text.done}</button></div>
      </footer>
    </section>
  </div>, document.body)
}
