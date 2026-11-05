import { useEffect, useRef, useState, type ComponentType } from 'react'
import type { Editor } from './engine'
import type { DesktopBridge } from './desktop'
import { modalKeyDown } from './modal-keyboard'
import { useInterfacePreferences } from './interface-preference'
import { automationText } from './automation-interface-messages'

type PanelProps = { editor: Editor; desktop: DesktopBridge | null | undefined; onHistory?: () => void }
type DialogComponent = ComponentType<PanelProps & { onClose: () => void }>

/** Keep the always-visible launcher cheap. Desktop MCP registration is owned
 * independently by App and never waits for this optional dialog import. */
export function AutomationPanel(props: PanelProps) { return <Launcher {...props} /> }
export function NativeAutomationDialog(props: PanelProps & { onDismiss: () => void }) { return <Launcher {...props} /> }

function Launcher({ onDismiss, ...props }: PanelProps & { onDismiss?: () => void }) {
  const [open, setOpen] = useState(!!onDismiss)
  const [Dialog, setDialog] = useState<DialogComponent | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const trigger = useRef<HTMLButtonElement>(null)
  const loadingClose = useRef<HTMLButtonElement>(null)
  const text = automationText[useInterfacePreferences().locale]
  useEffect(() => {
    if (!open || Dialog) return
    let current = true
    void import('./AutomationPanel').then(module => {
      if (current) setDialog(() => module.AutomationDialog)
    }).catch(failure => {
      if (current) setError(failure instanceof Error ? failure.message : String(failure))
    })
    // Closing, retrying or unmounting retires this load's UI ownership. The
    // browser may finish caching the module, but cannot reopen the dialog.
    return () => { current = false }
  }, [open, Dialog, attempt])
  const close = () => {
    setOpen(false)
    if (onDismiss) onDismiss(); else trigger.current?.focus()
  }
  return <div className={onDismiss ? undefined : 'automation-launcher'}>
    {!onDismiss && <button ref={trigger} type="button" onClick={() => { if (!open) { setError(''); setOpen(true) } }}>{text.open}</button>}
    {open && (Dialog ? <Dialog {...props} onClose={close} /> :
      <div className="modal-backdrop">
        <section className="remote-modal automation-dialog" role="dialog" aria-modal="true" aria-label={text.title}
          style={{ width: 'min(920px, calc(100vw - 32px))', maxHeight: '90vh', overflow: 'auto' }}
          onKeyDown={event => modalKeyDown(event, close)}>
          <h2>{text.title} <button ref={loadingClose} autoFocus type="button" aria-label={text.closeLabel} onClick={close}>{text.close}</button></h2>
          {error ? <><p role="alert">{text.loadFailed}{error}</p><button type="button" onClick={() => { loadingClose.current?.focus(); setError(''); setAttempt(value => value + 1) }}>{text.retry}</button></> :
            <p role="status" aria-live="polite">{text.loading}</p>}
        </section>
      </div>)}
  </div>
}
