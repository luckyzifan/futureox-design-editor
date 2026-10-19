import { useEffect, useRef, useState, type ComponentType } from 'react'
import type { Editor } from './engine'
import type { DesktopBridge } from './desktop'
import { modalKeyDown } from './modal-keyboard'

type PanelProps = { editor: Editor; desktop: DesktopBridge | null | undefined; onHistory?: () => void }
type DialogComponent = ComponentType<PanelProps & { onClose: () => void }>

/** Keep the always-visible launcher cheap. Desktop MCP registration is owned
 * independently by App and never waits for this optional dialog import. */
export function AutomationPanel(props: PanelProps) {
  const [open, setOpen] = useState(false)
  const [Dialog, setDialog] = useState<DialogComponent | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const trigger = useRef<HTMLButtonElement>(null)
  const loadingClose = useRef<HTMLButtonElement>(null)
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
    trigger.current?.focus()
  }
  return <>
    <button ref={trigger} type="button" onClick={() => { if (!open) { setError(''); setOpen(true) } }}>AI / MCP</button>
    {open && (Dialog ? <Dialog {...props} onClose={close} /> :
      <div className="modal-backdrop">
        <section className="remote-modal" role="dialog" aria-modal="true" aria-label="设计 API 与 MCP"
          style={{ width: 'min(900px,95vw)', maxHeight: '90vh', overflow: 'auto' }}
          onKeyDown={event => modalKeyDown(event, close)}>
          <h2>设计 API 与 MCP <button ref={loadingClose} autoFocus type="button" aria-label="关闭设计 API 与 MCP" onClick={close}>关闭</button></h2>
          {error ? <><p role="alert">面板载入失败：{error}</p><button type="button" onClick={() => { loadingClose.current?.focus(); setError(''); setAttempt(value => value + 1) }}>重试</button></> :
            <p role="status" aria-live="polite">正在载入设计 API 与 MCP…</p>}
        </section>
      </div>)}
  </>
}
